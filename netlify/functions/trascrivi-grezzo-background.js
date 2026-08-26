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
function extractAudio(token, driveFileId, outAudioPath, opts){
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(driveFileId) + "?alt=media&supportsAllDrives=true";
    const args = [ "-y", "-headers", "Authorization: Bearer " + token + "\r\n", "-i", url, "-vn" ];
    if(opts.enhance){ args.push("-af", "highpass=f=80,afftdn=nr=6,dynaudnorm=f=250:g=15:m=3"); }
    args.push("-ac", "1", "-ar", String(opts.rate||16000), "-b:a", String(opts.bitrate||"64k"), outAudioPath);
    const ff = spawn(ffmpegPath, args);
    let err = ""; ff.stderr.on("data", (d)=>{ err += d.toString(); });
    ff.on("error", reject);
    ff.on("close", (code)=> code === 0 ? resolve() : reject(new Error("ffmpeg " + code + ": " + err.slice(-300))));
  });
}
// converte un file audio locale in mono 16k (per Whisper) senza toccare i tempi
function ffmpegConvert(input, output, rate){
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ["-y","-i",input,"-vn","-ac","1","-ar",String(rate||16000),"-b:a","64k",output]);
    let err=""; ff.stderr.on("data",d=>{ err+=d.toString(); });
    ff.on("error", reject);
    ff.on("close", c=> c===0 ? resolve() : reject(new Error("ffmpeg convert "+c+": "+err.slice(-200))));
  });
}
// pulizia POTENTE: isola la voce con l'AI di ElevenLabs
async function elevenLabsIsolate(inputPath, outputPath){
  const key=process.env.ELEVENLABS_API_KEY;
  if(!key) throw new Error("Manca la chiave ELEVENLABS_API_KEY nelle variabili Netlify.");
  const buf=fs.readFileSync(inputPath);
  const form=new FormData();
  form.append("audio", new Blob([buf],{type:"audio/mpeg"}), "audio.mp3");
  const res=await fetch("https://api.elevenlabs.io/v1/audio-isolation",{ method:"POST", headers:{ "xi-api-key":key }, body:form });
  if(!res.ok){ const t=await res.text().catch(()=>""); throw new Error("ElevenLabs "+res.status+" "+t.slice(0,150)); }
  fs.writeFileSync(outputPath, Buffer.from(await res.arrayBuffer()));
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
// buchi di copertura: pezzi di [0..durata] NON coperti da nessuna parola
function coverageHoles(words, duration, tol){
  if(!duration || duration<=0) return [];
  const covered = mergeCovered(words, tol);
  return subtractCovered({ start:0, end:duration }, covered);
}
// quanta parte di un buco e' silenzio (0..1)
function silenceFraction(hole, silences){
  let sil=0;
  for(const s of (silences||[])){ const ov=Math.min(hole.end,s.end)-Math.max(hole.start,s.start); if(ov>0) sil+=ov; }
  const len=hole.end-hole.start;
  return len>0 ? sil/len : 1;
}
function extractSlice(audioPath, start, dur, outPath){
  return new Promise((resolve, reject)=>{
    const ff = spawn(ffmpegPath, ["-y", "-ss", String(start), "-i", audioPath, "-t", String(dur), "-ac", "1", "-ar", "16000", "-b:a", "64k", outPath]);
    let err=""; ff.stderr.on("data", d=>{ err+=d.toString(); });
    ff.on("error", reject);
    ff.on("close", c=> c===0 ? resolve() : reject(new Error("ffmpeg slice " + c)));
  });
}
async function transcribeHole(audioPath, g, duration){
  const pad=0.3, start=Math.max(0,g.start-pad), dur=Math.min(duration-start,(g.end+pad)-start);
  if(dur<0.4) return null;
  const slice="/tmp/gap_"+Date.now()+"_"+Math.round(start*1000)+"_"+Math.floor(Math.random()*1e6)+".mp3";
  try{
    await extractSlice(audioPath,start,dur,slice);
    const v=await whisperVerbose(slice);
    try{ fs.unlinkSync(slice); }catch(_){}
    if(!(v.text||"").trim()) return null;
    const kw=(Array.isArray(v.words)?v.words:[])
      .map(w=>({ word:w.word, start:(w.start||0)+start, end:(w.end||0)+start }))
      .filter(w=> w.start>=g.start-0.05 && w.end<=g.end+0.2);
    if(kw.length===0) return null;
    return { words:kw, seg:{ start:kw[0].start, end:kw[kw.length-1].end, text:kw.map(w=>w.word).join(" ") } };
  }catch(_){ try{ fs.unlinkSync(slice); }catch(__){} return null; }
}

// esegue fn su tutti gli item con al massimo "limit" in parallelo
async function mapLimit(items, limit, fn){
  const out=new Array(items.length); let i=0;
  async function worker(){ while(i<items.length){ const idx=i++; out[idx]=await fn(items[idx], idx); } }
  await Promise.all(Array.from({length:Math.min(limit, items.length)}, ()=>worker()));
  return out;
}

// riempie TUTTI i buchi di copertura (parlato senza testo), per avere la mappa COMPLETA
async function fillTranscript(audioPath, duration, silences, words, segments){
  if(!duration || duration<=0) return { words, segments, recovered:0, holesBefore:0, holesAfter:0, holesList:[] };
  const MINH=0.4, MAXSIL=0.97; // piu' aggressivo: riempie anche buchi corti o quasi-silenziosi
  const suspect = function(hs){ return hs.filter(h=> h.end-h.start >= MINH && silenceFraction(h,silences) < MAXSIL); };
  const holesBefore = suspect(coverageHoles(words, duration, 0.35)).reduce((a,h)=>a+(h.end-h.start),0);
  let allWords=words.slice(), allSegs=segments.slice(), recovered=0;
  for(let pass=0; pass<3; pass++){
    const holes = suspect(coverageHoles(allWords, duration, 0.35)).slice(0, 50);
    if(holes.length===0) break;
    let any=false;
    const results = await mapLimit(holes, 5, function(g){ return transcribeHole(audioPath, g, duration); });
    for(const r of results){ if(r){ allWords=allWords.concat(r.words); allSegs.push(r.seg); recovered++; any=true; } }
    if(!any) break;
  }
  const holesList = suspect(coverageHoles(allWords, duration, 0.35)).map(function(h){ return { start:+h.start.toFixed(2), end:+h.end.toFixed(2) }; });
  const holesAfter = holesList.reduce((a,h)=>a+(h.end-h.start),0);
  return { words: allWords, segments: allSegs, recovered, holesBefore, holesAfter, holesList };
}

function normW(x){ return String(x||"").toLowerCase().replace(/[\s.,!?;:"'’“”()\-]/g,""); }
// garantisce: nessun DOPPIONE vero, nessuna frase sovrapposta, tempi entro la durata
// (conservativo: NON scarta parole legittime, solo i duplicati evidenti)
function cleanTranscript(words, segments, duration){
  const D = duration || null;
  const ws=(words||[]).filter(w=> typeof w.start==="number" && typeof w.end==="number" && w.end>w.start).sort((a,b)=>a.start-b.start);
  const cw=[];
  for(const w of ws){
    const last=cw[cw.length-1];
    if(last){
      const ov=Math.min(w.end,last.end)-Math.max(w.start,last.start);
      const shorter=Math.min(w.end-w.start, last.end-last.start);
      // scarto SOLO se e' la STESSA parola con forte sovrapposizione temporale (doppione reale)
      if(ov>0 && shorter>0 && ov>=0.5*shorter && normW(w.word)===normW(last.word)) continue;
    }
    cw.push({ word:w.word, start:w.start, end:(D? Math.min(w.end,D) : w.end) });
  }
  const ss=(segments||[]).filter(s=> typeof s.start==="number" && typeof s.end==="number" && s.end>s.start).sort((a,b)=>a.start-b.start);
  const cs=[];
  for(const s of ss){
    let start=s.start, end=(D? Math.min(s.end,D) : s.end);
    const last=cs[cs.length-1];
    if(last && start < last.end - 0.02) start=last.end; // evita sovrapposizioni evidenti tra frasi
    if(end - start < 0.05) continue; // frase interamente contenuta in un'altra (stesso tempo = doppione) -> scarto
    cs.push({ start, end, text:(s.text||"").trim() });
  }
  cs.forEach((s,i)=>{ s.id=i; });
  const text=cs.map(s=>s.text).join(" ").replace(/\s+/g," ").trim();
  return { words:cw, segments:cs, text };
}

// IDEA 2: segmenti con POCO testo per TROPPO tempo (Whisper ha compresso/saltato).
// Ri-trascriviamo isolato quel pezzo: da solo Whisper non comprime e tira fuori tutto.
async function densifyOne(seg, words, audioPath, duration){
  const pad=0.2, start=Math.max(0, seg.start-pad), dur=Math.min(duration-start, (seg.end+pad)-start);
  if(dur<0.5) return null;
  const slice="/tmp/dens_"+Date.now()+"_"+Math.round(start*1000)+"_"+Math.floor(Math.random()*1e6)+".mp3";
  try{
    await extractSlice(audioPath, start, dur, slice);
    const v = await whisperVerbose(slice);
    try{ fs.unlinkSync(slice); }catch(_){}
    const nw=(Array.isArray(v.words)?v.words:[])
      .map(function(w){ return { word:w.word, start:(w.start||0)+start, end:(w.end||0)+start }; })
      .filter(function(w){ return w.start>=seg.start-0.1 && w.end<=seg.end+0.25; });
    const oldCount = words.filter(function(w){ return w.start>=seg.start-0.05 && w.start<seg.end+0.05; }).length;
    if(nw.length >= oldCount+2 && nw.length > oldCount*1.3){
      const ns=(Array.isArray(v.segments)?v.segments:[])
        .map(function(x){ return { start:(x.start||0)+start, end:(x.end||0)+start, text:(x.text||"").trim() }; })
        .filter(function(x){ return x.start>=seg.start-0.2 && x.end<=seg.end+0.35 && x.text; });
      return { seg, nw, ns };
    }
    return null;
  }catch(_){ try{ fs.unlinkSync(slice); }catch(__){} return null; }
}

async function densifyTranscript(audioPath, duration, words, segments){
  if(!duration || duration<=0) return { words, segments, densified:0 };
  const candidates = segments.filter(function(s){
    const dur = s.end - s.start; if(dur < 3) return false;
    const wc = words.filter(function(w){ return w.start>=s.start-0.05 && w.start<s.end+0.05; }).length;
    return (wc/dur) < 1.4;
  }).slice(0, 20);
  const results = await mapLimit(candidates, 4, function(seg){ return densifyOne(seg, words, audioPath, duration); });
  let allWords = words.slice();
  let newSegments = segments.slice();
  let densified = 0;
  for(const r of results){
    if(!r) continue;
    const seg=r.seg;
    allWords = allWords.filter(function(w){ return !(w.start>=seg.start-0.05 && w.start<seg.end+0.05); }).concat(r.nw);
    newSegments = newSegments.filter(function(x){ return x!==seg; }).concat(r.ns.length ? r.ns : [{ start:r.nw[0].start, end:r.nw[r.nw.length-1].end, text:r.nw.map(function(w){return w.word;}).join(" ") }]);
    densified++;
  }
  return { words: allWords, segments: newSegments, densified };
}

// ---------- R2 ----------
function hmac(key, str){ return crypto.createHmac("sha256", key).update(str, "utf8").digest(); }
function sha256hex(str){ return crypto.createHash("sha256").update(str, "utf8").digest("hex"); }
function sha256hexBuf(buf){ return crypto.createHash("sha256").update(buf).digest("hex"); }
async function r2Request(method, objectKey, bodyBuf, contentType){
  const accessKey=process.env.R2_ACCESS_KEY_ID, secretKey=process.env.R2_SECRET_ACCESS_KEY;
  const endpoint=process.env.R2_ENDPOINT, bucket=process.env.R2_BUCKET;
  const host=endpoint.replace(/^https?:\/\//,"");
  const region="auto", service="s3";
  const amzDate=new Date().toISOString().replace(/[:-]|\.\d{3}/g,"");
  const dateStamp=amzDate.slice(0,8);
  const canonicalUri="/"+bucket+"/"+objectKey.split("/").map(encodeURIComponent).join("/");
  const payload = bodyBuf || Buffer.alloc(0);
  const payloadHash = sha256hexBuf(payload);
  const canonicalHeaders="host:"+host+"\n"+"x-amz-content-sha256:"+payloadHash+"\n"+"x-amz-date:"+amzDate+"\n";
  const signedHeaders="host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest=[method,canonicalUri,"",canonicalHeaders,signedHeaders,payloadHash].join("\n");
  const credentialScope=dateStamp+"/"+region+"/"+service+"/aws4_request";
  const stringToSign=["AWS4-HMAC-SHA256",amzDate,credentialScope,sha256hex(canonicalRequest)].join("\n");
  const kSigning=hmac(hmac(hmac(hmac("AWS4"+secretKey,dateStamp),region),service),"aws4_request");
  const signature=crypto.createHmac("sha256",kSigning).update(stringToSign,"utf8").digest("hex");
  const headers={ "Authorization":"AWS4-HMAC-SHA256 Credential="+accessKey+"/"+credentialScope+", SignedHeaders="+signedHeaders+", Signature="+signature, "x-amz-date":amzDate, "x-amz-content-sha256":payloadHash };
  if(contentType && method!=="GET") headers["Content-Type"]=contentType;
  return fetch(endpoint+canonicalUri, { method, headers, body:(method==="GET"?undefined:payload) });
}
async function putBinaryToR2(key, buf, ct){ const r=await r2Request("PUT", key, buf, ct||"application/octet-stream"); if(!r.ok) throw new Error("R2 putbin "+r.status); return true; }
async function getBytesFromR2(key){ const r=await r2Request("GET", key, null); if(r.status===404) return null; if(!r.ok) throw new Error("R2 get "+r.status); return Buffer.from(await r.arrayBuffer()); }
async function getJsonFromR2(key){ const b=await getBytesFromR2(key); if(!b) return null; try{ return JSON.parse(b.toString("utf8")); }catch(_){ return null; } }

// FORZA: ri-trascrive un intervallo indicato a mano e lo fonde nella trascrizione
async function handleForceRange(driveFileId, rs, re){
  if(!(re>rs)) return { statusCode:400 };
  try { await putToR2("forced/"+driveFileId+".json", JSON.stringify({ done:false, at:new Date().toISOString(), range:[rs,re] })); } catch(_){}
  const audLocal="/tmp/forced_"+Date.now()+".mp3", slice="/tmp/fslice_"+Date.now()+".mp3";
  try{
    const abuf = await getBytesFromR2("audio/"+driveFileId+".mp3");
    if(!abuf) throw new Error("Audio non disponibile: ri-trascrivi prima il video intero.");
    fs.writeFileSync(audLocal, abuf);
    const tr = await getJsonFromR2("transcripts/"+driveFileId+".json");
    if(!tr) throw new Error("Trascrizione non trovata.");
    const pad=0.3, start=Math.max(0, rs-pad), dur=Math.max(0.4,(re+pad)-start);
    await extractSlice(audLocal, start, dur, slice);
    const v = await whisperVerbose(slice);
    const nw=(Array.isArray(v.words)?v.words:[]).map(w=>({ word:w.word, start:(w.start||0)+start, end:(w.end||0)+start })).filter(w=> w.start>=rs-0.1 && w.end<=re+0.2);
    const ns=(Array.isArray(v.segments)?v.segments:[]).map(x=>({ start:(x.start||0)+start, end:(x.end||0)+start, text:(x.text||"").trim() })).filter(x=> x.start>=rs-0.2 && x.end<=re+0.3 && x.text);
    try{fs.unlinkSync(slice);}catch(_){}
    try{fs.unlinkSync(audLocal);}catch(_){}
    const keepW=(tr.words||[]).filter(w=> !(w.start>=rs-0.05 && w.start<=re+0.05));
    const keepS=(tr.segments||[]).filter(sg=> !(sg.start>=rs-0.3 && sg.start<=re+0.3));
    const mergedW=keepW.concat(nw);
    const mergedS=keepS.concat(ns.length?ns:(nw.length?[{ start:nw[0].start, end:nw[nw.length-1].end, text:nw.map(w=>w.word).join(" ") }]:[]));
    const cleaned=cleanTranscript(mergedW, mergedS, tr.duration);
    tr.words=cleaned.words; tr.segments=cleaned.segments; tr.text=cleaned.text; tr.forcedAt=new Date().toISOString();
    await putToR2("transcripts/"+driveFileId+".json", JSON.stringify(tr,null,2));
    await putToR2("forced/"+driveFileId+".json", JSON.stringify({ done:true, at:new Date().toISOString(), addedWords:nw.length, range:[rs,re] }));
    console.log("Forzato "+rs.toFixed(1)+"-"+re.toFixed(1)+"s: +"+nw.length+" parole");
    return { statusCode:200 };
  }catch(e){
    try{fs.unlinkSync(slice);}catch(_){}
    try{fs.unlinkSync(audLocal);}catch(_){}
    const msg=String((e&&e.message)||e).slice(0,200);
    try{ await putToR2("forced/"+driveFileId+".json", JSON.stringify({ done:true, error:msg, at:new Date().toISOString() })); }catch(_){}
    console.log("Forza ERRORE:", msg);
    return { statusCode:500 };
  }
}
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

// SOLO MIGLIORAMENTO AUDIO (separato dalla trascrizione): estrae, pulisce e salva l'audio su R2
async function handleAudioOnly(driveFileId, mode){
  const aud="/tmp/prep_"+Date.now()+".mp3";
  let playerAudio=null;
  try{
    await putToR2("audio-status/"+driveFileId+".json", JSON.stringify({ done:false, mode, at:new Date().toISOString() }));
    const sa=JSON.parse(process.env.GOOGLE_SA_JSON);
    const token=await getSaToken(sa, SCOPE);
    if(mode==="power"){
      const audHi="/tmp/hi_"+Date.now()+".mp3";
      console.log("Miglioramento POTENTE: estraggo l'audio ad alta qualita'...");
      await extractAudio(token, driveFileId, audHi, { rate:44100, bitrate:"128k", enhance:false });
      const audClean="/tmp/clean_"+Date.now()+".mp3";
      console.log("Invio a ElevenLabs per isolare la voce...");
      await elevenLabsIsolate(audHi, audClean);
      try{ fs.unlinkSync(audHi); }catch(_){}
      playerAudio=audClean;
    } else {
      console.log(mode==="base" ? "Miglioramento BASE (FFmpeg)..." : "Estraggo l'audio senza pulizia...");
      await extractAudio(token, driveFileId, aud, { rate:16000, bitrate:"64k", enhance:(mode==="base") });
      playerAudio=aud;
    }
    await putBinaryToR2("audio/"+driveFileId+".mp3", fs.readFileSync(playerAudio), "audio/mpeg");
    try{ fs.unlinkSync(aud); }catch(_){}
    try{ if(playerAudio!==aud) fs.unlinkSync(playerAudio); }catch(_){}
    await putToR2("audio-status/"+driveFileId+".json", JSON.stringify({ done:true, mode, at:new Date().toISOString() }));
    console.log("Audio migliorato e salvato ("+mode+").");
    return { statusCode:200 };
  }catch(e){
    try{ fs.unlinkSync(aud); }catch(_){}
    const msg=String((e&&e.message)||e).slice(0,300);
    console.log("MIGLIORA ERRORE:", msg);
    try{ await putToR2("audio-status/"+driveFileId+".json", JSON.stringify({ done:true, error:msg, at:new Date().toISOString() })); }catch(_){}
    return { statusCode:500 };
  }
}

exports.handler = async (event) => {
  let body; try { body = JSON.parse(event.body || "{}"); } catch(_){ return { statusCode:400 }; }
  const driveFileId = body.driveFileId;
  if(!driveFileId) return { statusCode:400 };

  if(body.audioOnly){
    let mode=body.enhance; if(mode===true||mode==null) mode="base"; else if(mode===false) mode="none";
    return await handleAudioOnly(driveFileId, mode);
  }

  if(body.forceRange && body.forceRange.start!=null && body.forceRange.end!=null){
    return await handleForceRange(driveFileId, +body.forceRange.start, +body.forceRange.end);
  }

  const aud = "/tmp/grezzo_" + Date.now() + ".mp3";
  let playerAudio = null;
  let token;
  try {
    const sa = JSON.parse(process.env.GOOGLE_SA_JSON);
    token = await getSaToken(sa, SCOPE);

    const meta = await getFileMeta(token, driveFileId);
    if(!meta || !meta.id) throw new Error("File Drive non trovato: " + driveFileId);
    if(!String(meta.mimeType||"").startsWith("video/")) throw new Error("Il file non e' un video (" + meta.mimeType + ").");

    console.log("Estraggo l'audio da Drive (" + (meta.size ? Math.round(meta.size/1048576)+" MB" : "?") + ", " + (meta.mimeType||"?") + ")...");
    // usa l'audio gia' preparato/migliorato se presente, altrimenti estrai il grezzo
    const prepared = await getBytesFromR2("audio/"+driveFileId+".mp3");
    if(prepared && prepared.length>2000){
      const tmpIn="/tmp/prepin_"+Date.now()+".mp3"; fs.writeFileSync(tmpIn, prepared);
      await ffmpegConvert(tmpIn, aud, 16000);
      try{ fs.unlinkSync(tmpIn); }catch(_){}
      playerAudio=null; // gia' su R2, non risalvare
      console.log("Uso l'audio gia' preparato.");
    } else {
      console.log("Nessun audio preparato: estraggo il grezzo dal video.");
      await extractAudio(token, driveFileId, aud, { rate:16000, bitrate:"64k", enhance:false });
      playerAudio=aud;
    }

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
    // ridensifica i segmenti sospetti (poco testo per troppo tempo)
    let densified = 0;
    try {
      console.log("Controllo segmenti troppo sparsi (frase breve per tempo lungo)...");
      const dz = await densifyTranscript(aud, duration, words, segments);
      words = dz.words; segments = dz.segments; densified = dz.densified;
      console.log("Ridensificati " + densified + " segmenti sospetti.");
    } catch(e){ console.log("Ridensificazione saltata:", String((e&&e.message)||e).slice(0,120)); }

    let recovered = 0, coverage = null;
    try {
      console.log("Completo la mappa del trascritto (riempio i buchi con voce)...");
      const r = await fillTranscript(aud, duration, audioMap.silences, words, segments);
      words = r.words; segments = r.segments; recovered = r.recovered;
      coverage = { duration: duration? +duration.toFixed(1) : null, holesBefore: +r.holesBefore.toFixed(1), holesAfter: +r.holesAfter.toFixed(1), holes: r.holesList||[] };
      console.log("Copertura: parlato senza testo " + r.holesBefore.toFixed(1) + "s -> residuo " + r.holesAfter.toFixed(1) + "s (recuperati " + recovered + " pezzi)");
    } catch(e){ console.log("Completamento saltato:", String((e&&e.message)||e).slice(0,120)); }

    try { if(playerAudio){ await putBinaryToR2("audio/"+driveFileId+".mp3", fs.readFileSync(playerAudio), "audio/mpeg"); console.log("Audio salvato su R2 per l'ascolto."); } } catch(e){ console.log("Salvataggio audio saltato:", String((e&&e.message)||e).slice(0,80)); }
    try { fs.unlinkSync(aud); } catch(_){}
    try { if(playerAudio && playerAudio!==aud) fs.unlinkSync(playerAudio); } catch(_){}

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
      recovered,
      coverage,
      silences: (audioMap.silences||[]).map(function(x){ return { start:+x.start.toFixed(2), end:+x.end.toFixed(2) }; })
    };
    const objectKey = "transcripts/" + driveFileId + ".json";
    await putToR2(objectKey, JSON.stringify(transcriptObj, null, 2));
    console.log("OK: " + words.length + " parole, " + segments.length + " segmenti (recuperati " + recovered + ") -> R2 " + objectKey);
    return { statusCode:200 };
  } catch(e){
    try { fs.unlinkSync(aud); } catch(_){}
    try { if(playerAudio && playerAudio!==aud) fs.unlinkSync(playerAudio); } catch(_){}
    const msg = String((e && e.message) || e).slice(0, 300);
    console.log("ERRORE:", msg);
    try { await putToR2("errors/" + driveFileId + ".json", JSON.stringify({ error: msg, at: new Date().toISOString(), driveFileId }, null, 2)); } catch(_){}
    return { statusCode:500 };
  }
};
