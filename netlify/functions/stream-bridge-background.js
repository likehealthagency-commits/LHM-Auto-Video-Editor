// APP DI MONTAGGIO — PONTE Drive -> R2 -> Stream (Netlify BACKGROUND function)
// Stream non riesce a scaricare direttamente da Drive (link autenticato rifiutato).
// Allora: copiamo il video da Drive a R2 a pezzi (multipart, niente memoria esaurita),
// diamo a Stream un link firmato di R2 (che lui sa leggere), e appena Stream ha
// scaricato il video CANCELLIAMO la copia temporanea da R2. Nessun residuo.
//
// POST { driveFileId }. NOME FILE: deve finire con "-background".
// Variabili: GOOGLE_SA_JSON, STREAM_API_TOKEN, CF_ACCOUNT_ID, R2_*.

const crypto = require("crypto");
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

// ---------- Google ----------
function b64url(buf){ return Buffer.from(buf).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
async function getSaToken(sa, scope){
  const now=Math.floor(Date.now()/1000);
  const input=b64url(JSON.stringify({alg:"RS256",typ:"JWT"}))+"."+b64url(JSON.stringify({iss:sa.client_email,scope,aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600}));
  const signer=crypto.createSign("RSA-SHA256"); signer.update(input);
  const sig=b64url(signer.sign(sa.private_key));
  const res=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:input+"."+sig})});
  const data=await res.json(); if(!data.access_token) throw new Error("SA token"); return data.access_token;
}

// ---------- R2 (SigV4 con query, per il multipart) ----------
function hmac(k,s){ return crypto.createHmac("sha256",k).update(s,"utf8").digest(); }
function sha256hex(s){ return crypto.createHash("sha256").update(s,"utf8").digest("hex"); }
function rfc3986(x){ return encodeURIComponent(x).replace(/[!*'()]/g,c=>"%"+c.charCodeAt(0).toString(16).toUpperCase()); }
function canonicalQuery(q){ return Object.keys(q).sort().map(k=>rfc3986(k)+"="+rfc3986(q[k])).join("&"); }

async function r2Req(method, key, query, body){
  const accessKey=process.env.R2_ACCESS_KEY_ID, secretKey=process.env.R2_SECRET_ACCESS_KEY;
  const endpoint=process.env.R2_ENDPOINT, bucket=process.env.R2_BUCKET;
  const host=endpoint.replace(/^https?:\/\//,"");
  const region="auto", service="s3";
  const amzDate=new Date().toISOString().replace(/[:-]|\.\d{3}/g,"");
  const dateStamp=amzDate.slice(0,8);
  const canonicalUri="/"+bucket+"/"+key.split("/").map(rfc3986).join("/");
  const cq=canonicalQuery(query||{});
  const payloadBuf = (body && body.length) ? body : Buffer.alloc(0);
  const payloadHash = crypto.createHash("sha256").update(payloadBuf).digest("hex");
  const canonicalHeaders="host:"+host+"\n"+"x-amz-content-sha256:"+payloadHash+"\n"+"x-amz-date:"+amzDate+"\n";
  const signedHeaders="host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest=[method,canonicalUri,cq,canonicalHeaders,signedHeaders,payloadHash].join("\n");
  const scope=dateStamp+"/"+region+"/"+service+"/aws4_request";
  const stringToSign=["AWS4-HMAC-SHA256",amzDate,scope,sha256hex(canonicalRequest)].join("\n");
  const kSigning=hmac(hmac(hmac(hmac("AWS4"+secretKey,dateStamp),region),service),"aws4_request");
  const signature=crypto.createHmac("sha256",kSigning).update(stringToSign,"utf8").digest("hex");
  const headers={ "Authorization":"AWS4-HMAC-SHA256 Credential="+accessKey+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature, "x-amz-date":amzDate, "x-amz-content-sha256":payloadHash };
  const url=endpoint+canonicalUri+(cq?("?"+cq):"");
  return fetch(url,{ method, headers, body: (body && body.length) ? body : undefined });
}
async function r2Delete(key){ const r=await r2Req("DELETE",key,{},""); return r.ok || r.status===404; }
async function r2PutJson(key,obj){ const r=await r2Req("PUT",key,{},Buffer.from(JSON.stringify(obj,null,2),"utf8")); if(!r.ok) throw new Error("R2 putjson "+r.status); return true; }
async function r2GetJson(key){ const r=await r2Req("GET",key,{},""); if(r.status===404) return null; if(!r.ok) throw new Error("R2 getjson "+r.status); return r.json(); }

// PUT in streaming: il corpo scorre (stream), la firma usa UNSIGNED-PAYLOAD + Content-Length noto
async function r2PutStream(key, bodyStream, contentLength){
  const accessKey=process.env.R2_ACCESS_KEY_ID, secretKey=process.env.R2_SECRET_ACCESS_KEY;
  const endpoint=process.env.R2_ENDPOINT, bucket=process.env.R2_BUCKET;
  const host=endpoint.replace(/^https?:\/\//,"");
  const region="auto", service="s3";
  const amzDate=new Date().toISOString().replace(/[:-]|\.\d{3}/g,"");
  const dateStamp=amzDate.slice(0,8);
  const canonicalUri="/"+bucket+"/"+key.split("/").map(rfc3986).join("/");
  const payloadHash="UNSIGNED-PAYLOAD";
  const canonicalHeaders="host:"+host+"\n"+"x-amz-content-sha256:"+payloadHash+"\n"+"x-amz-date:"+amzDate+"\n";
  const signedHeaders="host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest=["PUT",canonicalUri,"",canonicalHeaders,signedHeaders,payloadHash].join("\n");
  const scope=dateStamp+"/"+region+"/"+service+"/aws4_request";
  const stringToSign=["AWS4-HMAC-SHA256",amzDate,scope,sha256hex(canonicalRequest)].join("\n");
  const kSigning=hmac(hmac(hmac(hmac("AWS4"+secretKey,dateStamp),region),service),"aws4_request");
  const signature=crypto.createHmac("sha256",kSigning).update(stringToSign,"utf8").digest("hex");
  const headers={ "Authorization":"AWS4-HMAC-SHA256 Credential="+accessKey+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature, "x-amz-date":amzDate, "x-amz-content-sha256":payloadHash, "Content-Length":String(contentLength), "Content-Type":"video/mp4" };
  return fetch(endpoint+canonicalUri,{ method:"PUT", headers, body: bodyStream, duplex:"half" });
}

function r2PresignGet(key, expires){
  const accessKey=process.env.R2_ACCESS_KEY_ID, secretKey=process.env.R2_SECRET_ACCESS_KEY;
  const endpoint=process.env.R2_ENDPOINT, bucket=process.env.R2_BUCKET;
  const host=endpoint.replace(/^https?:\/\//,"");
  const region="auto", service="s3";
  const amzDate=new Date().toISOString().replace(/[:-]|\.\d{3}/g,"");
  const dateStamp=amzDate.slice(0,8);
  const scope=dateStamp+"/"+region+"/"+service+"/aws4_request";
  const canonicalUri="/"+bucket+"/"+key.split("/").map(rfc3986).join("/");
  const params={ "X-Amz-Algorithm":"AWS4-HMAC-SHA256", "X-Amz-Credential":accessKey+"/"+scope, "X-Amz-Date":amzDate, "X-Amz-Expires":String(expires||7200), "X-Amz-SignedHeaders":"host" };
  const cqs=Object.keys(params).sort().map(k=>rfc3986(k)+"="+rfc3986(params[k])).join("&");
  const canonicalRequest=["GET",canonicalUri,cqs,"host:"+host+"\n","host","UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign=["AWS4-HMAC-SHA256",amzDate,scope,sha256hex(canonicalRequest)].join("\n");
  const kSigning=hmac(hmac(hmac(hmac("AWS4"+secretKey,dateStamp),region),service),"aws4_request");
  const signature=crypto.createHmac("sha256",kSigning).update(stringToSign,"utf8").digest("hex");
  return endpoint+canonicalUri+"?"+cqs+"&X-Amz-Signature="+signature;
}

// ---------- Cloudflare Stream ----------
const CF_BASE = () => "https://api.cloudflare.com/client/v4/accounts/"+process.env.CF_ACCOUNT_ID+"/stream";
async function streamCopyFromUrl(url, driveFileId){
  const res=await fetch(CF_BASE()+"/copy",{ method:"POST", headers:{"Authorization":"Bearer "+process.env.STREAM_API_TOKEN,"Content-Type":"application/json"}, body:JSON.stringify({ url, meta:{ name: driveFileId } }) });
  const d=await res.json().catch(()=>({}));
  if(!res.ok || !d.success) throw new Error("Stream copy "+res.status+" "+JSON.stringify(d.errors||d).slice(0,180));
  return d.result.uid;
}
async function streamGet(uid){
  const res=await fetch(CF_BASE()+"/"+uid,{ headers:{"Authorization":"Bearer "+process.env.STREAM_API_TOKEN} });
  const d=await res.json().catch(()=>({}));
  if(!res.ok || !d.success) throw new Error("Stream get "+res.status);
  return d.result;
}

// ---------- il ponte ----------
async function bridge(driveFileId){
  const mapKey="stream/"+driveFileId+".json";
  let m=null; try{ m=await r2GetJson(mapKey); }catch(_){}
  if(m && m.uid){ console.log("Gia' su Stream, salto."); return; }
  if(m && m.preparing && m.at && (Date.now()-m.at) < 20*60*1000){ console.log("Preparazione gia' in corso, salto."); return; }
  try{ await r2PutJson(mapKey, { preparing:true, at: Date.now() }); }catch(_){}
  try{ await doBridge(driveFileId); }
  catch(e){ try{ await r2PutJson(mapKey, { error: String((e&&e.message)||e).slice(0,200), at: Date.now() }); }catch(_){}; throw e; }
}

async function getSize(token, driveFileId){
  const q=new URLSearchParams({ fields:"size,name", supportsAllDrives:"true" });
  const r=await fetch("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(driveFileId)+"?"+q.toString(),{ headers:{ Authorization:"Bearer "+token } });
  if(!r.ok) return 0;
  const j=await r.json().catch(()=>({}));
  return j.size ? parseInt(j.size,10) : 0;
}

// VELOCE (come Palinsesto): scarica l'intero file in un colpo, poi UN solo PUT su R2
async function simpleUpload(driveUrl, token, srcKey, t0){
  const dl=await fetch(driveUrl,{ headers:{ Authorization:"Bearer "+token } });
  if(!dl.ok) throw new Error("Drive download "+dl.status);
  const b=Buffer.from(await dl.arrayBuffer());
  console.log("Drive: scaricati "+Math.round(b.length/1048576)+" MB in "+Math.round((Date.now()-t0)/1000)+"s. Carico su R2...");
  const pr=await r2Req("PUT", srcKey, {}, b);
  if(!pr.ok) throw new Error("R2 put "+pr.status+" "+(await pr.text()).slice(0,120));
}

// GRANDE: il file scorre da Drive direttamente in R2 (streaming, memoria bassa) - metodo Palinsesto
async function streamUpload(driveUrl, token, srcKey, size, t0){
  const dl=await fetch(driveUrl,{ headers:{ Authorization:"Bearer "+token } });
  if(!dl.ok || !dl.body) throw new Error("Drive download "+dl.status);
  console.log("Streaming Drive->R2 senza caricare in memoria ("+Math.round(size/1048576)+" MB)...");
  const r=await r2PutStream(srcKey, dl.body, size);
  if(!r.ok) throw new Error("R2 put stream "+r.status+" "+(await r.text()).slice(0,120));
}
async function doBridge(driveFileId){
  const t0=Date.now();
  const srcKey="sources/"+driveFileId+".mp4";
  const sa=JSON.parse(process.env.GOOGLE_SA_JSON);
  const token=await getSaToken(sa, "https://www.googleapis.com/auth/drive");
  const driveUrl="https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(driveFileId)+"?alt=media&supportsAllDrives=true";

  const size=await getSize(token, driveFileId);
  const SMALL=120*1024*1024;
  console.log("Video "+(size?Math.round(size/1048576)+" MB":"dimensione sconosciuta")+": scarico da Drive...");

  if(size>0 && size<=SMALL){
    await simpleUpload(driveUrl, token, srcKey, t0);
    console.log("Copia su R2 completata in "+Math.round((Date.now()-t0)/1000)+"s.");
  } else if(size>0){
    await streamUpload(driveUrl, token, srcKey, size, t0);
    console.log("Copia su R2 completata in "+Math.round((Date.now()-t0)/1000)+"s (streaming).");
  } else {
    await simpleUpload(driveUrl, token, srcKey, t0);
    console.log("Copia su R2 completata in "+Math.round((Date.now()-t0)/1000)+"s.");
  }

  const url=r2PresignGet(srcKey, 7200);
  console.log("Dico a Stream di scaricare da R2... (trasferimento finito in "+Math.round((Date.now()-t0)/1000)+"s)");
  const uid=await streamCopyFromUrl(url, driveFileId);
  await r2PutJson("stream/"+driveFileId+".json", { uid, createdAt:new Date().toISOString() });
  console.log("Stream uid: "+uid);

  for(let i=0;i<90;i++){
    await sleep(8000);
    let v; try{ v=await streamGet(uid); }catch(_){ continue; }
    const state=(v.status&&v.status.state)||"";
    if(v.readyToStream || state==="inprogress" || state==="ready" || state==="error"){
      await r2Delete(srcKey);
      console.log("Copia temporanea R2 cancellata (stato Stream: "+state+", totale "+Math.round((Date.now()-t0)/1000)+"s).");
      return;
    }
  }
  await r2Delete(srcKey);
  console.log("Copia temporanea R2 cancellata (timeout attesa).");
}

exports.handler = async (event) => {
  let body; try{ body=JSON.parse(event.body||"{}"); }catch(_){ return { statusCode:400 }; }
  const id=body.driveFileId; if(!id) return { statusCode:400 };
  try{ await bridge(id); return { statusCode:200 }; }
  catch(e){ console.log("PONTE ERRORE:", String((e&&e.message)||e).slice(0,300)); return { statusCode:500 }; }
};
