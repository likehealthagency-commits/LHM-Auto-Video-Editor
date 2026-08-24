// APP DI MONTAGGIO — PEZZO 2: il "cervello" (funzione sincrona)
// Legge la trascrizione a segmenti da R2, chiede a un LLM di marcare ogni segmento
// TIENI/SCARTA, e produce: script pulito + lista tagli con timecode (EDL).
//
// POST { driveFileId, force? }  -> { analysis }
//   Se l'analisi esiste gia' su R2 la restituisce (a meno di force:true).
//   Con { peek:true } restituisce l'analisi esistente o { analysis:null } senza calcolare.
//
// Salva analyses/<driveFileId>.json su R2.
// Variabili: OPENAI_API_KEY, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET.

const crypto = require("crypto");

// ---------- R2 (SigV4) ----------
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
  const userPayload = JSON.stringify(segments.map(s=>({ i:s.id, text:s.text })));
  const res = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ "Authorization":"Bearer "+key, "Content-Type":"application/json" },
    body: JSON.stringify({
      model:"gpt-4o-mini",
      temperature:0,
      response_format:{ type:"json_object" },
      messages:[ { role:"system", content:SYSTEM }, { role:"user", content:"Segmenti:\n"+userPayload } ]
    })
  });
  const d = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error("OpenAI "+res.status+" "+JSON.stringify(d).slice(0,160));
  let parsed; try{ parsed=JSON.parse(d.choices[0].message.content); }catch(_){ throw new Error("Risposta LLM non in JSON valido."); }
  return parsed.decisions || [];
}

// unisce i segmenti "keep" consecutivi in intervalli {start,end}
function buildKeepIntervals(orderedSegs, keepSet){
  const intervals=[]; let cur=null;
  for(const s of orderedSegs){
    if(keepSet.has(s.id)){
      if(cur) cur.end = s.end;
      else cur = { start:s.start, end:s.end };
    } else if(cur){ intervals.push(cur); cur=null; }
  }
  if(cur) intervals.push(cur);
  return intervals;
}

async function analyze(driveFileId){
  const tr = await r2GetJson("transcripts/"+driveFileId+".json");
  if(!tr) throw new Error("Trascrizione non trovata: analizza prima il video.");
  const segs = (tr.segments||[]).slice().sort((a,b)=>(a.start||0)-(b.start||0));
  if(segs.length===0) throw new Error("Nessun segmento nella trascrizione.");

  const decisions = await callLLM(segs);
  const byId = {}; decisions.forEach(d=>{ byId[d.i]=d; });

  const keepSet = new Set();
  const enriched = segs.map(s=>{
    const dec = byId[s.id] || { action:"keep", reason:"non valutato: tenuto per sicurezza" };
    const action = dec.action==="discard" ? "discard" : "keep";
    if(action==="keep") keepSet.add(s.id);
    return { i:s.id, start:s.start, end:s.end, text:s.text, action, reason:dec.reason||"" };
  });

  const kept = enriched.filter(e=>e.action==="keep");
  const cleanScript = kept.map(e=>e.text).join(" ").replace(/\s+/g," ").trim();
  const keep = buildKeepIntervals(segs, keepSet);

  const analysis = {
    version:1, createdAt:new Date().toISOString(), model:"gpt-4o-mini",
    driveFileId, source:tr.source||null, duration:tr.duration||null,
    decisions: enriched,
    cleanScript,
    keep,
    stats:{ total:segs.length, kept:kept.length, discarded:segs.length-kept.length }
  };
  await r2PutJson("analyses/"+driveFileId+".json", analysis);
  return analysis;
}

exports.handler = async (event) => {
  if(event.httpMethod!=="POST") return { statusCode:405, body:"Method not allowed" };
  let p; try{ p=JSON.parse(event.body||"{}"); }catch(_){ return { statusCode:400, body:JSON.stringify({error:"JSON non valido"}) }; }
  const id=p.driveFileId;
  if(!id) return { statusCode:400, body:JSON.stringify({error:"driveFileId mancante"}) };
  try{
    const existing = await r2GetJson("analyses/"+id+".json");
    if(p.peek) return { statusCode:200, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ analysis: existing }) };
    if(existing && !p.force) return { statusCode:200, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ analysis: existing }) };
    const analysis = await analyze(id);
    return { statusCode:200, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ analysis }) };
  }catch(e){
    return { statusCode:500, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ error:String((e&&e.message)||e) }) };
  }
};
