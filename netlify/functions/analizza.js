// APP DI MONTAGGIO — PEZZO 2: il "cervello" + TAGLIO DEI SILENZI (funzione sincrona)
// Marca ogni segmento TIENI/SCARTA (LLM) e produce: script pulito + EDL.
// In piu' toglie i silenzi (pause tra le parole oltre una soglia) usando i
// timestamp parola-per-parola gia' salvati nella trascrizione.
//
// POST { driveFileId, force?, peek?, toggle?, silence? }
//   toggle:<id>   -> inverte tieni/taglia di un segmento (e ricalcola)
//   silence:<sec> -> ricalcola solo i tagli dei silenzi con nuova soglia (no LLM)
//   peek:true     -> restituisce l'analisi esistente senza calcolare
//
// Salva analyses/<driveFileId>.json.  Variabili: OPENAI_API_KEY, R2_*.

const crypto = require("crypto");
const PAD = 0.08;          // margine attorno al parlato per non tagliare troppo stretto
const DEFAULT_SIL = 0.7;   // soglia predefinita: pause oltre 0,7s vengono tolte

// ---------- R2 ----------
function hmac(k,s){ return crypto.createHmac("sha256",k).update(s,"utf8").digest(); }
function sha256hex(s){ return crypto.createHash("sha256").update(s,"utf8").digest("hex"); }
async function r2Fetch(method, key, bodyString){
  const accessKey=process.env.R2_ACCESS_KEY_ID, secretKey=process.env.R2_SECRET_ACCESS_KEY;
  const endpoint=process.env.R2_ENDPOINT, bucket=process.env.R2_BUCKET;
  const host=endpoint.replace(/^https?:\/\//,"");
  const region="auto", service="s3";
  const amzDate=new Date().toISOString().replace(/[:-]|\.\d{3}/g,"");
  const dateStamp=amzDate.slice(0,8);
  const canonicalUri="/"+bucket+"/"+key.split("/").map(encodeURIComponent).join("/");
  const payload=bodyString||"", payloadHash=sha256hex(payload);
  const canonicalHeaders="host:"+host+"\n"+"x-amz-content-sha256:"+payloadHash+"\n"+"x-amz-date:"+amzDate+"\n";
  const signedHeaders="host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest=[method,canonicalUri,"",canonicalHeaders,signedHeaders,payloadHash].join("\n");
  const credentialScope=dateStamp+"/"+region+"/"+service+"/aws4_request";
  const stringToSign=["AWS4-HMAC-SHA256",amzDate,credentialScope,sha256hex(canonicalRequest)].join("\n");
  const kSigning=hmac(hmac(hmac(hmac("AWS4"+secretKey,dateStamp),region),service),"aws4_request");
  const signature=crypto.createHmac("sha256",kSigning).update(stringToSign,"utf8").digest("hex");
  const headers={ "Authorization":"AWS4-HMAC-SHA256 Credential="+accessKey+"/"+credentialScope+", SignedHeaders="+signedHeaders+", Signature="+signature, "x-amz-date":amzDate, "x-amz-content-sha256":payloadHash };
  if(method==="PUT") headers["Content-Type"]="application/json";
  return fetch(endpoint+canonicalUri,{ method, headers, body:(method==="PUT"?payload:undefined) });
}
async function r2GetJson(key){ const r=await r2Fetch("GET",key,""); if(r.status===404) return null; if(!r.ok) throw new Error("R2 get "+r.status); return r.json(); }
async function r2PutJson(key,obj){ const r=await r2Fetch("PUT",key,JSON.stringify(obj,null,2)); if(!r.ok) throw new Error("R2 put "+r.status); return true; }

// ---------- LLM ----------
const SYSTEM = [
"Sei un assistente di montaggio video. Ricevi la trascrizione di un video GREZZO non montato, diviso in segmenti numerati.",
"Il grezzo contiene: false partenze, frasi interrotte e subito riprese, ripetizioni dello stesso concetto (ri-registrazioni dello stesso pezzo), intercalari e sbavature.",
"Il tuo compito: per OGNI segmento decidere se TENERLO (keep) o SCARTARLO (discard), per ottenere un montato lineare e pulito che mantenga il senso del discorso.",
"Regole:",
"- Quando lo stesso contenuto viene detto piu' volte (ri-registrazioni), TIENI la versione migliore e piu' completa (di solito l'ultima, piu' fluida) e SCARTA i tentativi precedenti.",
"- SCARTA false partenze, frasi troncate e riprese, ripetizioni evidenti, sbavature.",
"- TIENI i segmenti che compongono il discorso finale coerente.",
"- Nel DUBBIO, TIENI e spiega il dubbio nel motivo (meglio lasciare da rifinire a mano che perdere contenuto buono).",
"- NON riscrivere il testo: decidi solo keep o discard.",
"- Ogni 'reason': una riga breve, in italiano.",
"Rispondi SOLO con un oggetto JSON in questo formato esatto:",
'{"decisions":[{"i":<numero del segmento>,"action":"keep" oppure "discard","reason":"..."}]}',
"Includi TUTTI i segmenti ricevuti, una decisione per ciascuno, nello stesso ordine."
].join("\n");

async function callLLM(segments){
  const key=process.env.OPENAI_API_KEY;
  const userPayload=JSON.stringify(segments.map(s=>({ i:s.id, text:s.text })));
  const res=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ "Authorization":"Bearer "+key, "Content-Type":"application/json" },
    body:JSON.stringify({ model:"gpt-4o-mini", temperature:0, response_format:{type:"json_object"}, messages:[{role:"system",content:SYSTEM},{role:"user",content:"Segmenti:\n"+userPayload}] })
  });
  const d=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error("OpenAI "+res.status+" "+JSON.stringify(d).slice(0,160));
  let parsed; try{ parsed=JSON.parse(d.choices[0].message.content); }catch(_){ throw new Error("Risposta LLM non in JSON valido."); }
  return parsed.decisions||[];
}

// ---------- calcoli ----------
function mergeKeepRaw(decisions){
  const intervals=[]; let cur=null;
  for(const d of decisions){
    if(d.action==="keep"){ if(cur) cur.end=d.end; else cur={start:d.start,end:d.end}; }
    else if(cur){ intervals.push(cur); cur=null; }
  }
  if(cur) intervals.push(cur);
  return intervals;
}
function sumDur(iv){ return (iv||[]).reduce((s,x)=>s+(x.end-x.start),0); }

// dentro ogni intervallo tenuto, spezza dove c'e' una pausa tra parole oltre soglia
function computeTight(keepRaw, words, threshold){
  const out=[];
  for(const iv of (keepRaw||[])){
    const ws=(words||[]).filter(w=> w.start>=iv.start-0.01 && w.start<iv.end+0.01).sort((a,b)=>a.start-b.start);
    if(ws.length===0){ out.push({start:iv.start,end:iv.end}); continue; }
    let cur={ start:Math.max(iv.start, ws[0].start-PAD), end:ws[0].end+PAD }, prevEnd=ws[0].end;
    for(let i=1;i<ws.length;i++){
      const w=ws[i], gap=w.start-prevEnd;
      if(gap>threshold){ cur.end=Math.min(iv.end,cur.end); out.push(cur); cur={ start:Math.max(iv.start,w.start-PAD), end:w.end+PAD }; }
      else cur.end=w.end+PAD;
      prevEnd=w.end;
    }
    cur.end=Math.min(iv.end, cur.end);
    out.push(cur);
  }
  return out.filter(iv=> iv.end-iv.start > 0.05);
}

function recompute(a){
  const decs=a.decisions||[];
  const kept=decs.filter(d=>d.action==="keep");
  a.cleanScript=kept.map(d=>d.text).join(" ").replace(/\s+/g," ").trim();
  a.keepRaw=mergeKeepRaw(decs);
  a.stats={ total:decs.length, kept:kept.length, discarded:decs.length-kept.length };
  return a;
}
function applySilence(a, words){
  const th=(typeof a.silenceThreshold==="number")?a.silenceThreshold:DEFAULT_SIL;
  a.keep=computeTight(a.keepRaw||[], words||[], th);
  a.silenceCutSeconds=Math.max(0, Math.round(sumDur(a.keepRaw||[]) - sumDur(a.keep)));
  return a;
}

async function analyze(driveFileId){
  const tr=await r2GetJson("transcripts/"+driveFileId+".json");
  if(!tr) throw new Error("Trascrizione non trovata: trascrivi prima il video.");
  const segs=(tr.segments||[]).slice().sort((a,b)=>(a.start||0)-(b.start||0));
  if(segs.length===0) throw new Error("Nessun segmento nella trascrizione.");
  const decisions=await callLLM(segs);
  const byId={}; decisions.forEach(d=>{ byId[d.i]=d; });
  const enriched=segs.map(s=>{
    const dec=byId[s.id]||{action:"keep",reason:"non valutato: tenuto per sicurezza"};
    const action=dec.action==="discard"?"discard":"keep";
    return { i:s.id, start:s.start, end:s.end, text:s.text, action, reason:dec.reason||"" };
  });
  const a={ version:2, createdAt:new Date().toISOString(), model:"gpt-4o-mini", driveFileId, source:tr.source||null, duration:tr.duration||null, decisions:enriched, silenceThreshold:DEFAULT_SIL };
  recompute(a);
  applySilence(a, tr.words||[]);
  await r2PutJson("analyses/"+driveFileId+".json", a);
  return a;
}

function ok(obj){ return { statusCode:200, headers:{"Content-Type":"application/json"}, body:JSON.stringify(obj) }; }

exports.handler = async (event) => {
  if(event.httpMethod!=="POST") return { statusCode:405, body:"Method not allowed" };
  let p; try{ p=JSON.parse(event.body||"{}"); }catch(_){ return { statusCode:400, body:JSON.stringify({error:"JSON non valido"}) }; }
  const id=p.driveFileId; if(!id) return { statusCode:400, body:JSON.stringify({error:"driveFileId mancante"}) };
  try{
    // inverti manualmente un segmento
    if(p.toggle!==undefined && p.toggle!==null){
      const a=await r2GetJson("analyses/"+id+".json"); if(!a) throw new Error("Analisi non trovata: esegui prima 'Trova i tagli'.");
      const dec=(a.decisions||[]).find(x=>x.i===p.toggle); if(!dec) throw new Error("Segmento non trovato.");
      dec.action=dec.action==="keep"?"discard":"keep";
      recompute(a);
      const tr=await r2GetJson("transcripts/"+id+".json"); applySilence(a, (tr&&tr.words)||[]);
      a.edited=true; a.editedAt=new Date().toISOString();
      await r2PutJson("analyses/"+id+".json", a);
      return ok({analysis:a});
    }
    // ricalcola solo i tagli dei silenzi con nuova soglia (senza LLM)
    if(p.silence!==undefined && p.silence!==null){
      const a=await r2GetJson("analyses/"+id+".json"); if(!a) throw new Error("Analisi non trovata: esegui prima 'Trova i tagli'.");
      a.silenceThreshold=+p.silence;
      if(!a.keepRaw) recompute(a);
      const tr=await r2GetJson("transcripts/"+id+".json"); applySilence(a, (tr&&tr.words)||[]);
      await r2PutJson("analyses/"+id+".json", a);
      return ok({analysis:a});
    }
    const existing=await r2GetJson("analyses/"+id+".json");
    if(p.peek) return ok({analysis:existing});
    if(existing && !p.force) return ok({analysis:existing});
    const a=await analyze(id);
    return ok({analysis:a});
  }catch(e){
    return { statusCode:500, headers:{"Content-Type":"application/json"}, body:JSON.stringify({error:String((e&&e.message)||e)}) };
  }
};
