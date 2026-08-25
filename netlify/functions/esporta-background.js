// APP DI MONTAGGIO — ESPORTAZIONE (Netlify BACKGROUND, FFmpeg)
// Rimonta il video: taglia gli spezzoni TENUTI (EDL dall'analisi) e li ricuce.
// Legge il video da Drive in streaming (FFmpeg via URL), ri-codifica per tagli precisi,
// carica il risultato su R2 e salva un link di download.
//
// POST { driveFileId }  -> esportazioni/<id>.json = { done, url?, error?, parts, sizeMB }
// Variabili: GOOGLE_SA_JSON, OPENAI non serve, R2_*.

const crypto = require("crypto");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const SCOPE = "https://www.googleapis.com/auth/drive";

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

function hmac(k,s){ return crypto.createHmac("sha256",k).update(s,"utf8").digest(); }
function sha256hex(s){ return crypto.createHash("sha256").update(s,"utf8").digest("hex"); }
function sha256hexBuf(b){ return crypto.createHash("sha256").update(b).digest("hex"); }
function rfc3986(x){ return encodeURIComponent(x).replace(/[!*'()]/g,c=>"%"+c.charCodeAt(0).toString(16).toUpperCase()); }

async function r2Send(method, key, bodyBuf, contentType){
  const accessKey=process.env.R2_ACCESS_KEY_ID, secretKey=process.env.R2_SECRET_ACCESS_KEY;
  const endpoint=process.env.R2_ENDPOINT, bucket=process.env.R2_BUCKET;
  const host=endpoint.replace(/^https?:\/\//,"");
  const region="auto", service="s3";
  const amzDate=new Date().toISOString().replace(/[:-]|\.\d{3}/g,"");
  const dateStamp=amzDate.slice(0,8);
  const canonicalUri="/"+bucket+"/"+key.split("/").map(rfc3986).join("/");
  const payload=bodyBuf||Buffer.alloc(0);
  const payloadHash=sha256hexBuf(payload);
  const canonicalHeaders="host:"+host+"\n"+"x-amz-content-sha256:"+payloadHash+"\n"+"x-amz-date:"+amzDate+"\n";
  const signedHeaders="host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest=[method,canonicalUri,"",canonicalHeaders,signedHeaders,payloadHash].join("\n");
  const scope=dateStamp+"/"+region+"/"+service+"/aws4_request";
  const stringToSign=["AWS4-HMAC-SHA256",amzDate,scope,sha256hex(canonicalRequest)].join("\n");
  const kSigning=hmac(hmac(hmac(hmac("AWS4"+secretKey,dateStamp),region),service),"aws4_request");
  const signature=crypto.createHmac("sha256",kSigning).update(stringToSign,"utf8").digest("hex");
  const headers={ "Authorization":"AWS4-HMAC-SHA256 Credential="+accessKey+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature, "x-amz-date":amzDate, "x-amz-content-sha256":payloadHash };
  if(contentType && method!=="GET") headers["Content-Type"]=contentType;
  return fetch(endpoint+canonicalUri,{ method, headers, body:(method==="GET"?undefined:payload) });
}
async function r2Put(key, buf, ct){ const r=await r2Send("PUT",key,buf,ct||"application/octet-stream"); if(!r.ok) throw new Error("R2 put "+r.status); return true; }
async function r2GetJson(key){ const r=await r2Send("GET",key,null); if(r.status===404) return null; if(!r.ok) throw new Error("R2 get "+r.status); return r.json(); }
async function r2PutJson(key,obj){ return r2Put(key, Buffer.from(JSON.stringify(obj,null,2),"utf8"), "application/json"); }
function r2PresignGet(key, expires){
  const accessKey=process.env.R2_ACCESS_KEY_ID, secretKey=process.env.R2_SECRET_ACCESS_KEY;
  const endpoint=process.env.R2_ENDPOINT, bucket=process.env.R2_BUCKET;
  const host=endpoint.replace(/^https?:\/\//,"");
  const region="auto", service="s3";
  const amzDate=new Date().toISOString().replace(/[:-]|\.\d{3}/g,"");
  const dateStamp=amzDate.slice(0,8);
  const canonicalUri="/"+bucket+"/"+key.split("/").map(rfc3986).join("/");
  const cred=accessKey+"/"+dateStamp+"/"+region+"/"+service+"/aws4_request";
  const q={ "X-Amz-Algorithm":"AWS4-HMAC-SHA256", "X-Amz-Credential":cred, "X-Amz-Date":amzDate, "X-Amz-Expires":String(expires), "X-Amz-SignedHeaders":"host" };
  const cq=Object.keys(q).sort().map(k=>rfc3986(k)+"="+rfc3986(q[k])).join("&");
  const canonicalRequest=["GET",canonicalUri,cq,"host:"+host+"\n","host","UNSIGNED-PAYLOAD"].join("\n");
  const scope=dateStamp+"/"+region+"/"+service+"/aws4_request";
  const stringToSign=["AWS4-HMAC-SHA256",amzDate,scope,sha256hex(canonicalRequest)].join("\n");
  const kSigning=hmac(hmac(hmac(hmac("AWS4"+secretKey,dateStamp),region),service),"aws4_request");
  const signature=crypto.createHmac("sha256",kSigning).update(stringToSign,"utf8").digest("hex");
  return endpoint+canonicalUri+"?"+cq+"&X-Amz-Signature="+signature;
}

function runFFmpeg(args){
  return new Promise((res,rej)=>{
    const ff=spawn(ffmpegPath,args);
    let err=""; ff.stderr.on("data",d=>{ err+=d.toString(); if(err.length>6000) err=err.slice(-6000); });
    ff.on("error",rej);
    ff.on("close",c=> c===0 ? res() : rej(new Error("ffmpeg "+c+": "+err.slice(-400))));
  });
}

exports.handler = async (event) => {
  let body; try{ body=JSON.parse(event.body||"{}"); }catch(_){ return {statusCode:400}; }
  const driveFileId=body.driveFileId;
  if(!driveFileId) return {statusCode:400};
  const Q={ originale:{t:0,crf:20}, "1080":{t:1080,crf:23}, "720":{t:720,crf:26} };
  const q=Q[body.quality]||Q["1080"];
  const out="/tmp/export_"+Date.now()+".mp4";
  const filterFile="/tmp/filter_"+Date.now()+".txt";
  try{
    await r2PutJson("esportazioni/"+driveFileId+".json", { done:false, at:new Date().toISOString() });
    const a=await r2GetJson("analyses/"+driveFileId+".json");
    if(!a) throw new Error("Analisi non trovata: apri il progetto e genera i tagli.");
    let edl=((a.keepManual&&a.keepManual.length)?a.keepManual:(a.keep||[]))
      .map(iv=>({start:+iv.start,end:+iv.end})).filter(iv=> iv.end>iv.start+0.02).sort((x,y)=>x.start-y.start);
    const merged=[]; for(const iv of edl){ const last=merged[merged.length-1]; if(last && iv.start-last.end<0.05) last.end=Math.max(last.end,iv.end); else merged.push({start:iv.start,end:iv.end}); }
    edl=merged;
    if(edl.length===0) throw new Error("Nessuna parte da esportare (tutto tagliato?).");
    if(edl.length>400) throw new Error("Troppi spezzoni ("+edl.length+"). Alleggerisci i tagli o i silenzi.");

    const sa=JSON.parse(process.env.GOOGLE_SA_JSON);
    const token=await getSaToken(sa, SCOPE);
    const driveUrl="https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(driveFileId)+"?alt=media&supportsAllDrives=true";

    const parts=[], labels=[];
    edl.forEach((iv,i)=>{
      parts.push("[0:v]trim=start="+iv.start+":end="+iv.end+",setpts=PTS-STARTPTS[v"+i+"]");
      parts.push("[0:a]atrim=start="+iv.start+":end="+iv.end+",asetpts=PTS-STARTPTS[a"+i+"]");
      labels.push("[v"+i+"][a"+i+"]");
    });
    let filter=parts.join(";")+";"+labels.join("")+"concat=n="+edl.length+":v=1:a=1[outv][outa]";
    let vmap="[outv]";
    const fmts={ "9:16":[9,16], "16:9":[16,9], "1:1":[1,1], "4:5":[4,5] };
    const fmt=fmts[body.format];
    if(fmt){
      const S=q.t>0?q.t:1080; const aw=fmt[0], ah=fmt[1];
      let W,H;
      if(aw<ah){ W=S; H=Math.round(S*ah/aw); } else if(aw>ah){ H=S; W=Math.round(S*aw/ah); } else { W=S; H=S; }
      W-=W%2; H-=H%2;
      filter+=";[outv]scale="+W+":"+H+":force_original_aspect_ratio=increase,crop="+W+":"+H+"[outvs]"; vmap="[outvs]";
    } else if(q.t>0){
      filter+=";[outv]scale='if(gt(iw,ih),-2,min("+q.t+",iw))':'if(gt(iw,ih),min("+q.t+",ih),-2)'[outvs]"; vmap="[outvs]";
    }
    fs.writeFileSync(filterFile, filter);

    console.log("Esporto "+edl.length+" spezzoni (qualita' "+(body.quality||"1080")+", formato "+(body.format||"original")+", crf "+q.crf+")...");
    await runFFmpeg(["-y","-headers","Authorization: Bearer "+token+"\r\n","-i",driveUrl,
      "-filter_complex_script",filterFile,"-map",vmap,"-map","[outa]",
      "-c:v","libx264","-preset","veryfast","-crf",String(q.crf),"-pix_fmt","yuv420p",
      "-c:a","aac","-b:a","128k","-movflags","+faststart", out]);

    const buf=fs.readFileSync(out);
    await r2Put("exports/"+driveFileId+".mp4", buf, "video/mp4");
    try{fs.unlinkSync(out);}catch(_){} try{fs.unlinkSync(filterFile);}catch(_){}
    const url=r2PresignGet("exports/"+driveFileId+".mp4", 7200);
    await r2PutJson("esportazioni/"+driveFileId+".json", { done:true, url, at:new Date().toISOString(), parts:edl.length, sizeMB:+(buf.length/1048576).toFixed(1), quality:(body.quality||"1080"), format:(body.format||"original") });
    console.log("Esportazione completata: "+(buf.length/1048576).toFixed(1)+" MB");
    return {statusCode:200};
  }catch(e){
    try{fs.unlinkSync(out);}catch(_){} try{fs.unlinkSync(filterFile);}catch(_){}
    const msg=String((e&&e.message)||e).slice(0,300);
    console.log("ESPORTA ERRORE:", msg);
    try{ await r2PutJson("esportazioni/"+driveFileId+".json", { done:true, error:msg, at:new Date().toISOString() }); }catch(_){}
    return {statusCode:500};
  }
};
