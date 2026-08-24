// APP DI MONTAGGIO — PULITORE R2 (una tantum, sincrono)
// Annulla i caricamenti multipart incompleti (i frammenti appesi) e cancella
// le copie temporanee sources/. Riporta cosa resta, senza toccare altro.
//
// POST {}  -> { multipartAnnullati, sourcesCancellati, bytesLiberati, altriOggetti:[...] }
// Variabili: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET.

const crypto = require("crypto");
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
  const canonicalUri="/"+bucket+(key?("/"+key.split("/").map(rfc3986).join("/")):"");
  const cq=canonicalQuery(query||{});
  const payloadBuf=(body&&body.length)?body:Buffer.alloc(0);
  const payloadHash=crypto.createHash("sha256").update(payloadBuf).digest("hex");
  const canonicalHeaders="host:"+host+"\n"+"x-amz-content-sha256:"+payloadHash+"\n"+"x-amz-date:"+amzDate+"\n";
  const signedHeaders="host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest=[method,canonicalUri,cq,canonicalHeaders,signedHeaders,payloadHash].join("\n");
  const scope=dateStamp+"/"+region+"/"+service+"/aws4_request";
  const stringToSign=["AWS4-HMAC-SHA256",amzDate,scope,sha256hex(canonicalRequest)].join("\n");
  const kSigning=hmac(hmac(hmac(hmac("AWS4"+secretKey,dateStamp),region),service),"aws4_request");
  const signature=crypto.createHmac("sha256",kSigning).update(stringToSign,"utf8").digest("hex");
  const headers={ "Authorization":"AWS4-HMAC-SHA256 Credential="+accessKey+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature, "x-amz-date":amzDate, "x-amz-content-sha256":payloadHash };
  const url=endpoint+canonicalUri+(cq?("?"+cq):"");
  return fetch(url,{ method, headers, body:(body&&body.length)?body:undefined });
}

function matchAll(re, str){ const out=[]; let m; while((m=re.exec(str))!==null) out.push(m); return out; }

async function listMultipart(){
  const res=await r2Req("GET","",{uploads:""},"");
  const xml=await res.text();
  if(!res.ok) throw new Error("list multipart "+res.status+" "+xml.slice(0,140));
  // ogni <Upload> ha <Key> e <UploadId>
  const uploads=[];
  for(const block of xml.split("<Upload>").slice(1)){
    const key=(block.match(/<Key>([^<]+)<\/Key>/)||[])[1];
    const uid=(block.match(/<UploadId>([^<]+)<\/UploadId>/)||[])[1];
    if(key && uid) uploads.push({key, uid});
  }
  return uploads;
}
async function listObjects(){
  const objs=[]; let token=null;
  do{
    const q={ "list-type":"2" }; if(token) q["continuation-token"]=token;
    const res=await r2Req("GET","",q,"");
    const xml=await res.text();
    if(!res.ok) throw new Error("list objects "+res.status+" "+xml.slice(0,140));
    for(const m of matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g, xml)){
      objs.push({ key:m[1], size:+m[2] });
    }
    const trunc=/<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = trunc ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)||[])[1] : null;
  } while(token);
  return objs;
}

exports.handler = async (event) => {
  if(event.httpMethod!=="POST") return { statusCode:405, body:"Method not allowed" };
  try{
    // 1) annulla i multipart incompleti
    const uploads=await listMultipart();
    let annullati=0;
    for(const u of uploads){
      const r=await r2Req("DELETE", u.key, {uploadId:u.uid}, "");
      if(r.ok || r.status===404) annullati++;
    }
    // 2) cancella le copie temporanee sources/
    const objs=await listObjects();
    let sourcesCancellati=0, bytesLiberati=0;
    const altri=[];
    for(const o of objs){
      if(o.key.startsWith("sources/")){
        const r=await r2Req("DELETE", o.key, {}, "");
        if(r.ok || r.status===404){ sourcesCancellati++; bytesLiberati+=o.size; }
      } else {
        altri.push({ key:o.key, sizeKB: Math.round(o.size/1024) });
      }
    }
    return { statusCode:200, headers:{"Content-Type":"application/json"}, body:JSON.stringify({
      multipartAnnullati: annullati,
      sourcesCancellati,
      MBLiberati: +(bytesLiberati/1048576).toFixed(1),
      altriOggetti: altri
    }, null, 2) };
  }catch(e){
    return { statusCode:500, headers:{"Content-Type":"application/json"}, body:JSON.stringify({error:String((e&&e.message)||e)}) };
  }
};
