// APP DI MONTAGGIO — INGEST SU CLOUDFLARE STREAM (funzione sincrona)
// Fa in modo che Cloudflare Stream prenda il video da Drive e lo ricodifichi (gratis).
//
// POST { action, driveFileId }
//   action "ingest": dice a Stream di copiare il video da Drive -> restituisce { uid }
//   action "status": stato del video su Stream -> { state, ready, hls, error }
//
// Mappatura salvata su R2: stream/<driveFileId>.json = { uid, createdAt }
// Variabili: GOOGLE_SA_JSON, STREAM_API_TOKEN, CF_ACCOUNT_ID, R2_*.

const crypto = require("crypto");

// ---------- Google ----------
function b64url(buf){ return Buffer.from(buf).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
async function getSaToken(sa, scope){
  const now=Math.floor(Date.now()/1000);
  const header=b64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claim=b64url(JSON.stringify({iss:sa.client_email,scope,aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600}));
  const input=header+"."+claim;
  const signer=crypto.createSign("RSA-SHA256"); signer.update(input);
  const sig=b64url(signer.sign(sa.private_key));
  const res=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:input+"."+sig})});
  const data=await res.json(); if(!data.access_token) throw new Error("SA token"); return data.access_token;
}

// ---------- R2 (per la mappatura driveFileId->uid) ----------
function hmac(k,s){ return crypto.createHmac("sha256",k).update(s,"utf8").digest(); }
function sha256hex(s){ return crypto.createHash("sha256").update(s,"utf8").digest("hex"); }
async function r2Fetch(method,key,bodyString){
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
  const headers={"Authorization":"AWS4-HMAC-SHA256 Credential="+accessKey+"/"+credentialScope+", SignedHeaders="+signedHeaders+", Signature="+signature,"x-amz-date":amzDate,"x-amz-content-sha256":payloadHash};
  if(method==="PUT") headers["Content-Type"]="application/json";
  return fetch(endpoint+canonicalUri,{method,headers,body:(method==="PUT"?payload:undefined)});
}
async function r2GetJson(key){ const r=await r2Fetch("GET",key,""); if(r.status===404) return null; if(!r.ok) throw new Error("R2 get "+r.status); return r.json(); }
async function r2PutJson(key,obj){ const r=await r2Fetch("PUT",key,JSON.stringify(obj,null,2)); if(!r.ok) throw new Error("R2 put "+r.status); return true; }

// ---------- Cloudflare Stream ----------
const CF_BASE = () => "https://api.cloudflare.com/client/v4/accounts/"+process.env.CF_ACCOUNT_ID+"/stream";

async function streamCopyFromUrl(mediaUrl, driveFileId){
  const res=await fetch(CF_BASE()+"/copy",{
    method:"POST",
    headers:{"Authorization":"Bearer "+process.env.STREAM_API_TOKEN,"Content-Type":"application/json"},
    body:JSON.stringify({ url: mediaUrl, meta:{ name: driveFileId } })
  });
  const d=await res.json().catch(()=>({}));
  if(!res.ok || !d.success){ throw new Error("Stream copy "+res.status+" "+JSON.stringify(d.errors||d).slice(0,180)); }
  return d.result.uid;
}
async function streamGet(uid){
  const res=await fetch(CF_BASE()+"/"+uid,{ headers:{"Authorization":"Bearer "+process.env.STREAM_API_TOKEN} });
  const d=await res.json().catch(()=>({}));
  if(!res.ok || !d.success){ throw new Error("Stream get "+res.status+" "+JSON.stringify(d.errors||d).slice(0,180)); }
  return d.result;
}

async function actIngest(driveFileId){
  const existing=await r2GetJson("stream/"+driveFileId+".json");
  if(existing && existing.uid) return { uid: existing.uid };
  const sa=JSON.parse(process.env.GOOGLE_SA_JSON);
  const token=await getSaToken(sa, "https://www.googleapis.com/auth/drive");
  // Piano A: link Drive con access_token in query (Stream lo scarica da solo)
  const mediaUrl="https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(driveFileId)+"?alt=media&supportsAllDrives=true&access_token="+token;
  const uid=await streamCopyFromUrl(mediaUrl, driveFileId);
  await r2PutJson("stream/"+driveFileId+".json", { uid, createdAt:new Date().toISOString() });
  return { uid };
}
async function actStatus(driveFileId){
  const existing=await r2GetJson("stream/"+driveFileId+".json");
  if(!existing || !existing.uid) return { state:"none" };
  const v=await streamGet(existing.uid);
  return {
    state: (v.status && v.status.state) || "unknown",
    ready: !!v.readyToStream,
    hls: (v.playback && v.playback.hls) || null,
    error: (v.status && v.status.errorReasonText) || ""
  };
}

exports.handler = async (event) => {
  if(event.httpMethod!=="POST") return { statusCode:405, body:"Method not allowed" };
  let p; try{ p=JSON.parse(event.body||"{}"); }catch(_){ return { statusCode:400, body:JSON.stringify({error:"JSON non valido"}) }; }
  const id=p.driveFileId; if(!id) return { statusCode:400, body:JSON.stringify({error:"driveFileId mancante"}) };
  try{
    let out;
    if(p.action==="ingest") out=await actIngest(id);
    else if(p.action==="status") out=await actStatus(id);
    else return { statusCode:400, body:JSON.stringify({error:"Azione sconosciuta"}) };
    return { statusCode:200, headers:{"Content-Type":"application/json"}, body:JSON.stringify(out) };
  }catch(e){
    return { statusCode:500, headers:{"Content-Type":"application/json"}, body:JSON.stringify({error:String((e&&e.message)||e)}) };
  }
};
