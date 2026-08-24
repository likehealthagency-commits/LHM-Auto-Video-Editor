// APP DI MONTAGGIO — PEZZO 1: TRASCRIZIONE (+ recupero del parlato saltato)
// Netlify BACKGROUND function.
//
// Flusso:
// - FFmpeg legge il video da Drive (range request) ed estrae solo l'audio mp3 mono 16k.
// - Whisper trascrive (timestamp per parola e per segmento).
// - RECUPERO: analizza l'audio (silenzi vs voce). Dove c'e' VOCE ma NESSUNA parola
//   trascritta (Whisper ha saltato/soppresso una ripetizione), ritaglia quel pezzetto
//   e lo ri-trascrive da solo: su un clip corto Whisper non sopprime le ripetizioni.
//   Il testo recuperato viene reinserito con i suoi tempi.
// - Salva transcripts/<driveFileId>.json su R2.
//
// Variabili: GOOGLE_SA_JSON, OPENAI_API_KEY, R2_*.  NOME FILE: deve finire con "-background".

const crypto = require("crypto");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const SCOPE = "https://www.googleapis.com/auth/drive";

function b64url(buf){ return Buffer.from(buf).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
async function getSaToken(sa, scope){
  const now = Math.floor(Date.now()/1000);
  const header = b64url(JSON.stringify({ alg:"RS256", typ:"JWT" }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope, aud:"https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const input = header + "." + claim;
  const signer = crypto.createSign("RSA-SHA256"); signer.update(input);
  const sig = b64url(signer.sign(sa.private_key));
  const res = await fetch("https://oauth2.googleapis.com/token", { method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: input + "." + sig }) });
  const data = await res.json(); if(!data.access_token) throw new Error("SA token"); return data.access_token;
}
async function getFileMeta(token, fileId){
  const p = new URLSearchParams({ fields:"id,name,size,parents,mimeType", supportsAllDrives:"true" });
  const res = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?" + p.toString(), { headers:{ "Authorization":"Bearer "+token } });
  if(!res.ok) throw new Error("Drive meta " + res.status + " " + (await res.text()).slice(0,140));
  return res.json();
}
function extractAudioFromDriveUrl(token, driveFileId, outAudioPath){
  return new Promise((resolve, reject) => {
    const url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(driveFileId) + "?alt=media&supportsAllDrives=true";
    const ff = spawn(ffmpegPath, [ "-y", "-headers", "Authorization: Bearer " + token + "\r\n", "-i", url, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", outAudioPath ]);
    let err = ""; ff.stderr.on("data", (d)=>{ err += d.toString(); });
    ff.on("error", reject);
    ff.on("close", (code)=> code === 0 ? resolve() : reject(new Error("ffmpeg " + code + ": " + err.slice(-300))));
  });
}
async function whisperVerbose(audioPath){
  const key = process.env.OPENAI_API_KEY;
  const buf = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type:"audio/mpeg" }), "audio.mp3");
  form.append("model", "whisper-1");
  form.append("language", "it");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method:"POST", headers:{ "Authorization":"Bearer "+key }, body: form });
  const d = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error("Whisper " + res.status + " " + JSON.stringify(d).slice(0,140));
  return d;
}

// ---------- RECUPERO PARLATO SALTATO ----------
function analyzeAudio(audioPath){
  return new Promise((resolve)=>{
    const ff = spawn(ffmpegPath, ["-i", audioPath, "-af", "silencedetect=noise=-30dB:d=0.7", "-f", "null", "-"]);
    let err = ""; ff.stderr.on("data", d=>{ err += d.toString(); });
    ff.on("error", ()=>resolve({ duration:null, silences:[] }));
    ff.on("close", ()=>{
      let duration=null;
      const dm = err.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if(dm) duration = (+dm[1])*3600 + (+dm[2])*60 + parseFloat(dm[3]);
      const sil=[]; let curStart=null;
      for(const line of err.split("\n")){
        const ms = line.match(/silence_start:\s*(-?[0-9.]+)/);
        const me = line.match(/silence_end:\s*([0-9.]+)/);
        if(ms) curStart = Math.max(0, parseFloat(ms[1]));
        else if(me && curStart!==null){ sil.push({ start:curStart, end:parseFloat(me[1]) }); curStart=null; }
      }
      if(curStart!==null && duration) sil.push({ start:curStart, end:duration });
      resolve({ duration, silences:sil });
    });
  });
}
function complement(intervals, total){
  const sorted = intervals.slice().sort((a,b)=>a.start-b.start);
  const out=[]; let cursor=0;
  for(const iv of sorted){
    const s=Math.max(0,iv.start), e=Math.min(total,iv.end);
    if(s>cursor) out.push({ start:cursor, end:s });
    cursor=Math.max(cursor,e);
  }
  if(cursor<total) out.push({ start:cursor, end:total });
  return out;
}
function mergeCovered(words, tol){
  const iv = words.map(w=>({start:w.start,end:w.end})).sort((a,b)=>a.start-b.start);
  const out=[];
  for(const w of iv){
    if(out.length && w.start <= out[out.length-1].end + tol) out[out.length-1].end = Math.max(out[out.length-1].end, w.end);
    else out.push({ start:w.start, end:w.end });
  }
  return out;
}
function subtractCovered(iv, covered){
  let segs=[{ start:iv.start, end:iv.end }];
  for(const c of covered){
    const next=[];
    for(const s of segs){
      if(c.end<=s.start || c.start>=s.end){ next.push(s); continue; }
      if(c.start>s.start) next.push({ start:s.start, end:Math.min(c.start,s.end) });
      if(c.end<s.end) next.push({ start:Math.max(c.end,s.start), end:s.end });
    }
    segs=next;
  }
  return segs;
}
function findGaps(words, silences, duration, minGap){
  if(!duration || duration<=0) return [];
  const speech = complement(silences, duration);
  const covered = mergeCovered(words, 0.35);
  const gaps=[];
  for(const sp of speech){
    for(const g of subtractCovered(sp, covered)){
      if(g.end - g.start >= minGap) gaps.push(g);
    }
  }
  return gaps;
}
function extractSlice(audioPath, start, dur, outPath){
  return new Promise((resolve, reject)=>{
    const ff = spawn(ffmpegPath, ["-y", "-ss", String(start), "-i", audioPath, "-t", String(dur), "-ac", "1", "-ar", "16000", "-b:a", "64k", outPath]);
    let err=""; ff.stderr.on("data", d=>{ err+=d.toString(); });
    ff.on("error", reject);
    ff.on("close", c=> c===0 ? resolve() : reject(new Error("ffmpeg slice " + c)));
  });
}
async function recoverGaps(audioPath, duration, silences, words, segments){
  const gaps = findGaps(words, silences, duration||0, 1.0).slice(0, 25);
  if(gaps.length===0) return { words, segments, recovered:0 };
  let addedWords=[], addedSegs=[], recovered=0;
  for(const g of gaps){
    const pad=0.3;
    const start=Math.max(0, g.start-pad);
    const dur=Math.min((duration||g.end)-start, (g.end+pad)-start);
    if(dur<0.4) continue;
    const slice="/tmp/gap_"+Date.now()+"_"+Math.round(start*1000)+".mp3";
    try{
      await extractSlice(audioPath, start, dur, slice);
      const v = await whisperVerbose(slice);
      try { fs.unlinkSync(slice); } catch(_){}
      if(!(v.text||"").trim()) continue;
      // tieni SOLO le parole che cadono dentro il buco (niente sconfinamenti = niente sovrapposizioni)
      const kw=(Array.isArray(v.words)?v.words:[])
        .map(w=>({ word:w.word, start:(w.start||0)+start, end:(w.end||0)+start }))
        .filter(w=> w.start>=g.start-0.05 && w.end<=g.end+0.15);
      if(kw.length===0) continue;
      addedWords=addedWords.concat(kw);
      addedSegs.push({ start:kw[0].start, end:kw[kw.length-1].end, text:kw.map(w=>w.word).join(" ") });
      recovered++;
    }catch(_){ try{ fs.unlinkSync(slice); }catch(__){} }
  }
  if(recovered===0) return { words, segments, recovered:0 };
  return { words: words.concat(addedWords), segments: segments.concat(addedSegs), recovered };
}

// garantisce: parole senza duplicati/sovrapposizioni, segmenti senza sovrapposizioni, tempi entro la durata
function cleanTranscript(words, segments, duration){
  const D = duration || null;
  const ws=(words||[]).filter(w=> typeof w.start==="number" && typeof w.end==="number" && w.end>w.start).sort((a,b)=>a.start-b.start);
  const cw=[];
  for(const w of ws){
    const last=cw[cw.length-1];
    if(last && w.start < last.end - 0.06) continue; // sovrapposizione = parola duplicata: la scarto
    cw.push({ word:w.word, start:w.start, end:(D? Math.min(w.end,D) : w.end) });
  }
  const ss=(segments||[]).filter(s=> typeof s.start==="number" && typeof s.end==="number" && s.end>s.start).sort((a,b)=>a.start-b.start);
  const cs=[];
  for(const s of ss){
    let start=s.start, end=(D? Math.min(s.end,D) : s.end);
    const last=cs[cs.length-1];
    if(last && start < last.end) start=last.end;   // niente sovrapposizioni tra frasi
    if(end - start < 0.05) continue;
    cs.push({ start, end, text:(s.text||"").trim() });
  }
  cs.forEach((s,i)=>{ s.id=i; });
  const text=cs.map(s=>s.text).join(" ").replace(/\s+/g," ").trim();
  return { words:cw, segments:cs, text };
}

// ---------- R2 ----------
function hmac(key, str){ return crypto.createHmac("sha256", key).update(str, "utf8").digest(); }
function sha256hex(str){ return crypto.createHash("sha256").update(str, "utf8").digest("hex"); }
async function putToR2(objectKey, bodyString){
  const accessKey=process.env.R2_ACCESS_KEY_ID, secretKey=process.env.R2_SECRET_ACCESS_KEY;
  const endpoint=process.env.R2_ENDPOINT, bucket=process.env.R2_BUCKET;
  const host=endpoint.replace(/^https?:\/\//,"");
  const region="auto", service="s3";
  const now=new Date();
  const amzDate=now.toISOString().replace(/[:-]|\.\d{3}/g,"");
  const dateStamp=amzDate.slice(0,8);
  const canonicalUri="/"+bucket+"/"+objectKey.split("/").map(encodeURIComponent).join("/");
  const payloadHash=sha256hex(bodyString);
  const canonicalHeaders="host:"+host+"\n"+"x-amz-content-sha256:"+payloadHash+"\n"+"x-amz-date:"+amzDate+"\n";
  const signedHeaders="host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest=["PUT",canonicalUri,"",canonicalHeaders,signedHeaders,payloadHash].join("\n");
  const credentialScope=dateStamp+"/"+region+"/"+service+"/aws4_request";
  const stringToSign=["AWS4-HMAC-SHA256",amzDate,credentialScope,sha256hex(canonicalRequest)].join("\n");
  const kSigning=hmac(hmac(hmac(hmac("AWS4"+secretKey,dateStamp),region),service),"aws4_request");
  const signature=crypto.createHmac("sha256",kSigning).update(stringToSign,"utf8").digest("hex");
  const authorization="AWS4-HMAC-SHA256 Credential="+accessKey+"/"+credentialScope+", SignedHeaders="+signedHeaders+", Signature="+signature;
  const res=await fetch(endpoint+canonicalUri,{ method:"PUT", headers:{ "Authorization":authorization, "x-amz-date":amzDate, "x-amz-content-sha256":payloadHash, "Content-Type":"application/json" }, body:bodyString });
  if(!res.ok) throw new Error("R2 put "+res.status+" "+(await res.text()).slice(0,160));
  return objectKey;
}

exports.handler = async (event) => {
  let body; try { body = JSON.parse(event.body || "{}"); } catch(_){ return { statusCode:400 }; }
  const driveFileId = body.driveFileId;
  if(!driveFileId) return { statusCode:400 };

  const aud = "/tmp/grezzo_" + Date.now() + ".mp3";
  let token;
  try {
    const sa = JSON.parse(process.env.GOOGLE_SA_JSON);
    token = await getSaToken(sa, SCOPE);

    const meta = await getFileMeta(token, driveFileId);
    if(!meta || !meta.id) throw new Error("File Drive non trovato: " + driveFileId);
    if(!String(meta.mimeType||"").startsWith("video/")) throw new Error("Il file non e' un video (" + meta.mimeType + ").");

    console.log("Estraggo l'audio da Drive (" + (meta.size ? Math.round(meta.size/1048576)+" MB" : "?") + ", " + (meta.mimeType||"?") + ")...");
    await extractAudioFromDriveUrl(token, driveFileId, aud);

    let sizeMB = 0; try { sizeMB = fs.statSync(aud).size / 1048576; } catch(_){ sizeMB = 0; }
    console.log("Audio " + sizeMB.toFixed(2) + " MB -> Whisper...");
    if(sizeMB < 0.005) throw new Error("Audio vuoto: FFmpeg non ha estratto suono dal video.");
    if(sizeMB > 24.5) throw new Error("Audio troppo lungo per la trascrizione (oltre ~24 MB, ~50 min).");

    const v = await whisperVerbose(aud);
    if(!(v.text || "").trim()) throw new Error("Trascrizione vuota.");
    let words = (Array.isArray(v.words)?v.words:[]).map(function(w){ return { word:w.word, start:w.start, end:w.end }; });
    let segments = (Array.isArray(v.segments)?v.segments:[]).map(function(s){ return { id:s.id, start:s.start, end:s.end, text:(s.text||"").trim() }; });

    // durata REALE dell'audio + mappa dei silenzi (una sola passata FFmpeg)
    const audioMap = await analyzeAudio(aud);
    const duration = audioMap.duration || v.duration || (words.length ? words[words.length-1].end : null);
    console.log("Durata audio: " + (duration? duration.toFixed(1)+"s" : "?") + " · silenzi rilevati: " + audioMap.silences.length);

    // recupero del parlato eventualmente saltato da Whisper (buchi con voce ma senza testo)
    let recovered = 0;
    try {
      console.log("Cerco parlato eventualmente saltato...");
      const r = await recoverGaps(aud, duration, audioMap.silences, words, segments);
      words = r.words; segments = r.segments; recovered = r.recovered;
      console.log(recovered>0 ? ("Recuperati " + recovered + " pezzi di parlato mancante.") : "Nessun pezzo mancante rilevato.");
    } catch(e){ console.log("Recupero saltato:", String((e&&e.message)||e).slice(0,120)); }

    try { fs.unlinkSync(aud); } catch(_){}

    // pulizia finale: niente sovrapposizioni, niente parole duplicate, tempi entro la durata
    const cleaned = cleanTranscript(words, segments, duration);
    words = cleaned.words; segments = cleaned.segments;
    const text = cleaned.text;

    const transcriptObj = {
      version: 2,
      createdAt: new Date().toISOString(),
      source: { driveFileId, name: meta.name, sizeMB: meta.size ? +(meta.size/1048576).toFixed(1) : null },
      language: v.language || "it",
      duration,
      text,
      segments,
      words,
      recovered
    };
    const objectKey = "transcripts/" + driveFileId + ".json";
    await putToR2(objectKey, JSON.stringify(transcriptObj, null, 2));
    console.log("OK: " + words.length + " parole, " + segments.length + " segmenti (recuperati " + recovered + ") -> R2 " + objectKey);
    return { statusCode:200 };
  } catch(e){
    try { fs.unlinkSync(aud); } catch(_){}
    const msg = String((e && e.message) || e).slice(0, 300);
    console.log("ERRORE:", msg);
    try { await putToR2("errors/" + driveFileId + ".json", JSON.stringify({ error: msg, at: new Date().toISOString(), driveFileId }, null, 2)); } catch(_){}
    return { statusCode:500 };
  }
};
