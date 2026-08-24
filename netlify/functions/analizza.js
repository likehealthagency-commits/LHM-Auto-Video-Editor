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
"- RI-REGISTRAZIONI (regola importante): quando due o piu' segmenti dicono la STESSA cosa o quasi (la persona ha ripetuto la frase per dirla meglio), TIENI SEMPRE l'ULTIMA versione, cioe' quella piu' avanti nel tempo (id piu' alto), e SCARTA quelle precedenti. Chi ri-registra lo fa per correggersi: l'ultima ripetizione e' quasi sempre quella buona. NON tenere mai la prima di una serie di ripetizioni simili.",
"- NON scartare un segmento che contiene anche informazioni NUOVE, UTILI o UNICHE solo perche' una parte ripete qualcosa gia' detto: nel dubbio TIENILO (l'utente potra' dividerlo e rifinirlo a mano).",
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
// spezza i segmenti di Whisper in unita' piu' fini dove c'e' una pausa netta tra le parole,
// cosi' ripetizioni e ri-registrazioni nascoste dentro un segmento emergono come righe separate
function refineSegments(segments, words, gap){
  const out=[];
  for(const seg of (segments||[])){
    const ws=(words||[]).filter(w=> w.start>=seg.start-0.01 && w.start<seg.end+0.01).sort((a,b)=>(a.start||0)-(b.start||0));
    if(ws.length<4){ out.push({ start:seg.start, end:seg.end, text:seg.text }); continue; }
    const cuts=[];
    for(let k=1;k<ws.length;k++){ if((ws[k].start - ws[k-1].end) > gap) cuts.push(k); }
    if(cuts.length===0){ out.push({ start:seg.start, end:seg.end, text:seg.text }); continue; }
    let startIdx=0; const bounds=cuts.concat([ws.length]);
    for(const b of bounds){
      const pc=ws.slice(startIdx,b); startIdx=b;
      if(pc.length>0) out.push({ start:pc[0].start, end:pc[pc.length-1].end, text:pc.map(w=>w.word).join(" ") });
    }
  }
  out.sort((a,b)=>(a.start||0)-(b.start||0));
  out.forEach((seg,i)=>{ seg.id=i; });
  return out;
}

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
  const segs0=(tr.segments||[]).slice().sort((a,b)=>(a.start||0)-(b.start||0));
  if(segs0.length===0) throw new Error("Nessun segmento nella trascrizione.");
  const segs=refineSegments(segs0, tr.words||[], 0.55);
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

function hkey(id){ return "analyses/"+id+".history.json"; }
async function pushHistory(id, snapshot){
  const h=(await r2GetJson(hkey(id)))||{undo:[],redo:[]};
  h.undo=h.undo||[]; h.undo.push(snapshot);
  while(h.undo.length>40) h.undo.shift();
  h.redo=[];
  await r2PutJson(hkey(id), h);
}
async function respondWith(id, analysis){
  const h=(await r2GetJson(hkey(id)))||{undo:[],redo:[]};
  return ok({ analysis, canUndo:!!(h.undo&&h.undo.length>0), canRedo:!!(h.redo&&h.redo.length>0) });
}
async function actUndo(id){
  const h=(await r2GetJson(hkey(id)))||{undo:[],redo:[]};
  const cur=await r2GetJson("analyses/"+id+".json");
  if(!h.undo || h.undo.length===0) return ok({ analysis:cur, canUndo:false, canRedo:!!(h.redo&&h.redo.length>0) });
  const prev=h.undo.pop(); h.redo=h.redo||[]; if(cur) h.redo.push(cur);
  await r2PutJson(hkey(id), h);
  await r2PutJson("analyses/"+id+".json", prev);
  return ok({ analysis:prev, canUndo:h.undo.length>0, canRedo:h.redo.length>0 });
}
async function actRedo(id){
  const h=(await r2GetJson(hkey(id)))||{undo:[],redo:[]};
  const cur=await r2GetJson("analyses/"+id+".json");
  if(!h.redo || h.redo.length===0) return ok({ analysis:cur, canUndo:!!(h.undo&&h.undo.length>0), canRedo:false });
  const next=h.redo.pop(); h.undo=h.undo||[]; if(cur) h.undo.push(cur);
  await r2PutJson(hkey(id), h);
  await r2PutJson("analyses/"+id+".json", next);
  return ok({ analysis:next, canUndo:h.undo.length>0, canRedo:h.redo.length>0 });
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
      await pushHistory(id, JSON.parse(JSON.stringify(a)));
      dec.action=dec.action==="keep"?"discard":"keep";
      recompute(a);
      const tr=await r2GetJson("transcripts/"+id+".json"); applySilence(a, (tr&&tr.words)||[]);
      delete a.keepManual; a.manualKeep=false;
      a.edited=true; a.editedAt=new Date().toISOString();
      await r2PutJson("analyses/"+id+".json", a);
      return await respondWith(id, a);
    }
    // divide un segmento in due parti al tempo indicato (per separare parte buona e ripetizione)
    if(p.split && p.split.i!==undefined && p.split.atTime!==undefined){
      const a=await r2GetJson("analyses/"+id+".json"); if(!a) throw new Error("Analisi non trovata.");
      const tr=await r2GetJson("transcripts/"+id+".json"); const words=(tr&&tr.words)||[];
      const idx=(a.decisions||[]).findIndex(x=>x.i===p.split.i); if(idx<0) throw new Error("Segmento non trovato.");
      const seg=a.decisions[idx]; const atTime=+p.split.atTime;
      const ws=words.filter(w=> w.start>=seg.start-0.01 && w.start<seg.end+0.01).sort((x,y)=>x.start-y.start);
      const before=ws.filter(w=> w.start < atTime), after=ws.filter(w=> w.start >= atTime);
      if(before.length===0 || after.length===0) throw new Error("Punto di divisione non valido.");
      await pushHistory(id, JSON.parse(JSON.stringify(a)));
      const partA={ i:seg.i, start:seg.start, end:before[before.length-1].end, text:before.map(w=>w.word).join(" "), action:seg.action, reason:"diviso a mano" };
      const partB={ i:seg.i, start:after[0].start, end:seg.end, text:after.map(w=>w.word).join(" "), action:seg.action, reason:"diviso a mano" };
      a.decisions.splice(idx,1,partA,partB);
      a.decisions.sort((x,y)=>(x.start||0)-(y.start||0));
      a.decisions.forEach((d,k)=>{ d.i=k; });
      recompute(a); applySilence(a, words);
      delete a.keepManual; a.manualKeep=false; a.edited=true;
      await r2PutJson("analyses/"+id+".json", a);
      return await respondWith(id, a);
    }
    // ricalcola solo i tagli dei silenzi con nuova soglia (senza LLM)
    if(p.silence!==undefined && p.silence!==null){
      const a=await r2GetJson("analyses/"+id+".json"); if(!a) throw new Error("Analisi non trovata: esegui prima 'Trova i tagli'.");
      await pushHistory(id, JSON.parse(JSON.stringify(a)));
      a.silenceThreshold=+p.silence;
      if(!a.keepRaw) recompute(a);
      const tr=await r2GetJson("transcripts/"+id+".json"); applySilence(a, (tr&&tr.words)||[]);
      delete a.keepManual; a.manualKeep=false;
      await r2PutJson("analyses/"+id+".json", a);
      return await respondWith(id, a);
    }
    // salva un EDL modificato a mano (trascinamento bordi nell'editor)
    if(p.setKeep){
      const a=await r2GetJson("analyses/"+id+".json"); if(!a) throw new Error("Analisi non trovata.");
      await pushHistory(id, JSON.parse(JSON.stringify(a)));
      a.keepManual=(Array.isArray(p.setKeep)?p.setKeep:[]).map(iv=>({start:+iv.start,end:+iv.end})).filter(iv=> iv.end>iv.start+0.02).sort((x,y)=>x.start-y.start);
      a.manualKeep=true;
      await r2PutJson("analyses/"+id+".json", a);
      return await respondWith(id, a);
    }
    if(p.clearManual){
      const a=await r2GetJson("analyses/"+id+".json"); if(!a) throw new Error("Analisi non trovata.");
      await pushHistory(id, JSON.parse(JSON.stringify(a)));
      delete a.keepManual; a.manualKeep=false;
      await r2PutJson("analyses/"+id+".json", a);
      return await respondWith(id, a);
    }
    if(p.undo) return await actUndo(id);
    if(p.redo) return await actRedo(id);
    const existing=await r2GetJson("analyses/"+id+".json");
    if(p.peek) return await respondWith(id, existing);
    if(existing && !p.force) return await respondWith(id, existing);
    if(existing) await pushHistory(id, JSON.parse(JSON.stringify(existing)));
    const a=await analyze(id);
    return await respondWith(id, a);
  }catch(e){
    return { statusCode:500, headers:{"Content-Type":"application/json"}, body:JSON.stringify({error:String((e&&e.message)||e)}) };
  }
};
