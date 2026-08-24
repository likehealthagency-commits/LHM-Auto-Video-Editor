// APP DI MONTAGGIO — PROXY (Netlify BACKGROUND function)
// Genera una copia LEGGERA (480p) del video grezzo per l'anteprima nell'editor,
// leggendo il video da Drive con FFmpeg e caricandola su R2: proxies/<driveFileId>.mp4
// Con -movflags +faststart il browser puo' riprodurla e riavvolgerla in streaming.
//
// Riceve { driveFileId }. Variabili: GOOGLE_SA_JSON, R2_*.
// NOME FILE: deve finire con "-background".

const crypto = require("crypto");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

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

function makeProxy(token, driveFileId, outPath){
  return new Promise((resolve, reject) => {
    const url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(driveFileId) + "?alt=media&supportsAllDrives=true";
    const ff = spawn(ffmpegPath, [
      "-y",
      "-headers", "Authorization: Bearer " + token + "\r\n",
      "-i", url,
      "-vf", "scale=-2:480",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+faststart",
      outPath
    ]);
    let err = ""; ff.stderr.on("data", d=>{ err += d.toString(); });
    ff.on("error", reject);
    ff.on("close", c => c===0 ? resolve() : reject(new Error("ffmpeg " + c + ": " + err.slice(-300))));
  });
}

// R2 PUT binario (SigV4)
function hmac(k,s){ return crypto.createHmac("sha256",k).update(s,"utf8").digest(); }
function sha256hex(s){ return crypto.createHash("sha256").update(s,"utf8").digest("hex"); }
async function r2PutBinary(key, buffer, contentType){
  const accessKey=process.env.R2_ACCESS_KEY_ID, secretKey=process.env.R2_SECRET_ACCESS_KEY;
  const endpoint=process.env.R2_ENDPOINT, bucket=process.env.R2_BUCKET;
  const host=endpoint.replace(/^https?:\/\//,"");
  const region="auto", service="s3";
  const amzDate=new Date().toISOString().replace(/[:-]|\.\d{3}/g,"");
  const dateStamp=amzDate.slice(0,8);
  const canonicalUri="/"+bucket+"/"+key.split("/").map(encodeURIComponent).join("/");
  const payloadHash=crypto.createHash("sha256").update(buffer).digest("hex");
  const canonicalHeaders="host:"+host+"\n"+"x-amz-content-sha256:"+payloadHash+"\n"+"x-amz-date:"+amzDate+"\n";
  const signedHeaders="host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest=["PUT",canonicalUri,"",canonicalHeaders,signedHeaders,payloadHash].join("\n");
  const credentialScope=dateStamp+"/"+region+"/"+service+"/aws4_request";
  const stringToSign=["AWS4-HMAC-SHA256",amzDate,credentialScope,sha256hex(canonicalRequest)].join("\n");
  const kSigning=hmac(hmac(hmac(hmac("AWS4"+secretKey,dateStamp),region),service),"aws4_request");
  const signature=crypto.createHmac("sha256",kSigning).update(stringToSign,"utf8").digest("hex");
  const headers={ "Authorization":"AWS4-HMAC-SHA256 Credential="+accessKey+"/"+credentialScope+", SignedHeaders="+signedHeaders+", Signature="+signature, "x-amz-date":amzDate, "x-amz-content-sha256":payloadHash, "Content-Type":contentType||"application/octet-stream" };
  const res=await fetch(endpoint+canonicalUri,{ method:"PUT", headers, body:buffer });
  if(!res.ok) throw new Error("R2 put "+res.status+" "+(await res.text()).slice(0,140));
  return true;
}

exports.handler = async (event) => {
  let body; try{ body=JSON.parse(event.body||"{}"); }catch(_){ return { statusCode:400 }; }
  const driveFileId=body.driveFileId; if(!driveFileId) return { statusCode:400 };
  const out="/tmp/proxy_"+Date.now()+".mp4";
  try{
    const sa=JSON.parse(process.env.GOOGLE_SA_JSON);
    const token=await getSaToken(sa, "https://www.googleapis.com/auth/drive");
    console.log("Genero proxy 480p per "+driveFileId+"...");
    await makeProxy(token, driveFileId, out);
    const buf=fs.readFileSync(out);
    console.log("Proxy "+(buf.length/1048576).toFixed(2)+" MB -> R2...");
    await r2PutBinary("proxies/"+driveFileId+".mp4", buf, "video/mp4");
    try{ fs.unlinkSync(out); }catch(_){}
    console.log("Proxy pronto: proxies/"+driveFileId+".mp4");
    return { statusCode:200 };
  }catch(e){
    try{ fs.unlinkSync(out); }catch(_){}
    console.log("PROXY ERRORE:", String((e&&e.message)||e).slice(0,300));
    return { statusCode:500 };
  }
};
