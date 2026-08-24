// APP DI MONTAGGIO — API PROGETTI (funzione sincrona)
// Gestisce i "progetti" su Cloudflare R2. Un solo file, tante azioni.
//
// Azioni (POST { action, ... }):
//   list | summaries | create{name} | get{projectId} | rename{projectId,name}
//   addRaw{projectId,link} | reorderRaw{projectId,rawId,direction} | deleteRaw{projectId,rawId}
//   deleteProject{projectId}  (cancella anche le trascrizioni su R2)
//   status{driveFileId} | transcript{driveFileId}
//
// Dati su R2:
//   projects/_index.json   -> { projects:[ {id,name,createdAt} ] }
//   projects/<id>.json     -> { id,name,createdAt, raws:[ {id,driveFileId,link,name,sizeMB,order,status} ] }
//   transcripts/<driveFileId>.json  (trascrizioni, scritte dall'altra function)
//
// Variabili: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET, GOOGLE_SA_JSON.

const crypto = require("crypto");

function newId(prefix){ return (prefix||"") + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex"); }

function parseDriveId(input){
  const s = String(input || "").trim();
  let m = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/); if(m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/); if(m) return m[1];
  if(/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

// ---------- Google (per leggere il NOME del video) ----------
function b64url(buf){ return Buffer.from(buf).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
async function getSaToken(sa, scope){
  const now = Math.floor(Date.now()/1000);
  const header = b64url(JSON.stringify({ alg:"RS256", typ:"JWT" }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope, aud:"https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const input = header + "." + claim;
  const signer = crypto.createSign("RSA-SHA256"); signer.update(input);
  const sig = b64url(signer.sign(sa.private_key));
  const res = await fetch("https://oauth2.googleapis.com/token", { method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: input + "." + sig }) });
  const data = await res.json();
  if(!data.access_token) throw new Error("SA token");
  return data.access_token;
}
async function driveMeta(driveFileId){
  // best-effort: se fallisce, restituisce {} e si usa l'ID
  try{
    const sa = JSON.parse(process.env.GOOGLE_SA_JSON);
    const token = await getSaToken(sa, "https://www.googleapis.com/auth/drive");
    const p = new URLSearchParams({ fields:"id,name,size,mimeType", supportsAllDrives:"true" });
    const res = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(driveFileId) + "?" + p.toString(), { headers:{ "Authorization":"Bearer "+token } });
    if(!res.ok) return {};
    const d = await res.json();
    return { name: d.name || null, sizeMB: d.size ? +(d.size/1048576).toFixed(1) : null };
  }catch(_){ return {}; }
}

// ---------- R2 (SigV4) ----------
function hmac(key, str){ return crypto.createHmac("sha256", key).update(str, "utf8").digest(); }
function sha256hex(str){ return crypto.createHash("sha256").update(str, "utf8").digest("hex"); }
async function r2Fetch(method, key, bodyString){
  const accessKey = process.env.R2_ACCESS_KEY_ID, secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT, bucket = process.env.R2_BUCKET;
  const host = endpoint.replace(/^https?:\/\//, "");
  const region = "auto", service = "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = "/" + bucket + "/" + key.split("/").map(encodeURIComponent).join("/");
  const payload = bodyString || "";
  const payloadHash = sha256hex(payload);
  const canonicalHeaders = "host:" + host + "\n" + "x-amz-content-sha256:" + payloadHash + "\n" + "x-amz-date:" + amzDate + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [ method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash ].join("\n");
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = dateStamp + "/" + region + "/" + service + "/aws4_request";
  const stringToSign = [ algorithm, amzDate, credentialScope, sha256hex(canonicalRequest) ].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4"+secretKey, dateStamp), region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const headers = { "Authorization": algorithm + " Credential=" + accessKey + "/" + credentialScope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  if(method === "PUT") headers["Content-Type"] = "application/json";
  return fetch(endpoint + canonicalUri, { method, headers, body: (method === "PUT" ? payload : undefined) });
}
async function r2GetJson(key){ const res = await r2Fetch("GET", key, ""); if(res.status===404) return null; if(!res.ok) throw new Error("R2 get "+res.status); return res.json(); }
async function r2PutJson(key, obj){ const res = await r2Fetch("PUT", key, JSON.stringify(obj, null, 2)); if(!res.ok) throw new Error("R2 put "+res.status); return true; }
async function r2Delete(key){ const res = await r2Fetch("DELETE", key, ""); if(!res.ok && res.status!==404) throw new Error("R2 del "+res.status); return true; }
async function r2Exists(key){ const res = await r2Fetch("GET", key, ""); return res.ok; }

function rfc3986(x){ return encodeURIComponent(x).replace(/[!*'()]/g,c=>"%"+c.charCodeAt(0).toString(16).toUpperCase()); }
function r2PresignGet(key, expires){
  const accessKey=process.env.R2_ACCESS_KEY_ID, secretKey=process.env.R2_SECRET_ACCESS_KEY;
  const endpoint=process.env.R2_ENDPOINT, bucket=process.env.R2_BUCKET;
  const host=endpoint.replace(/^https?:\/\//,"");
  const region="auto", service="s3";
  const amzDate=new Date().toISOString().replace(/[:-]|\.\d{3}/g,"");
  const dateStamp=amzDate.slice(0,8);
  const scope=dateStamp+"/"+region+"/"+service+"/aws4_request";
  const canonicalUri="/"+bucket+"/"+key.split("/").map(rfc3986).join("/");
  const params={ "X-Amz-Algorithm":"AWS4-HMAC-SHA256", "X-Amz-Credential":accessKey+"/"+scope, "X-Amz-Date":amzDate, "X-Amz-Expires":String(expires||21600), "X-Amz-SignedHeaders":"host" };
  const cqs=Object.keys(params).sort().map(k=>rfc3986(k)+"="+rfc3986(params[k])).join("&");
  const canonicalRequest=["GET",canonicalUri,cqs,"host:"+host+"\n","host","UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign=["AWS4-HMAC-SHA256",amzDate,scope,sha256hex(canonicalRequest)].join("\n");
  const kSigning=hmac(hmac(hmac(hmac("AWS4"+secretKey,dateStamp),region),service),"aws4_request");
  const signature=crypto.createHmac("sha256",kSigning).update(stringToSign,"utf8").digest("hex");
  return endpoint+canonicalUri+"?"+cqs+"&X-Amz-Signature="+signature;
}

async function actApprove(p){
  const a=await r2GetJson("analyses/"+p.driveFileId+".json");
  if(!a) throw new Error("Nessuna analisi da approvare.");
  a.approved=true; a.approvedAt=new Date().toISOString();
  await r2PutJson("analyses/"+p.driveFileId+".json", a);
  return { analysis:a };
}
async function actProxyStatus(p){ return { status: (await r2Exists("proxies/"+p.driveFileId+".mp4")) ? "ready" : "none" }; }
async function actProxyUrl(p){
  if(!(await r2Exists("proxies/"+p.driveFileId+".mp4"))) throw new Error("Anteprima non ancora pronta.");
  return { url: r2PresignGet("proxies/"+p.driveFileId+".mp4", 21600) };
}

const INDEX_KEY = "projects/_index.json";
async function readIndex(){ return (await r2GetJson(INDEX_KEY)) || { projects: [] }; }
async function writeIndex(idx){ return r2PutJson(INDEX_KEY, idx); }
function ordered(raws){ return (raws||[]).slice().sort((a,b)=>(a.order||0)-(b.order||0)); }

// ---------- azioni ----------
async function actList(){
  const idx = await readIndex();
  const list = (idx.projects||[]).slice().sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));
  return { projects: list };
}

async function actSummaries(){
  const idx = await readIndex();
  const out = [];
  for(const entry of (idx.projects||[])){
    const prj = await r2GetJson("projects/" + entry.id + ".json");
    const raws = (prj && prj.raws) ? prj.raws : [];
    let done = 0;
    for(const r of raws){ if(await r2Exists("transcripts/" + r.driveFileId + ".json")) done++; }
    out.push({ id: entry.id, name: entry.name, createdAt: entry.createdAt, rawCount: raws.length, doneCount: done });
  }
  out.sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));
  return { projects: out };
}

async function actCreate(p){
  const name = String(p.name||"").trim();
  if(!name) throw new Error("Nome progetto mancante.");
  const id = newId("prj-");
  const project = { id, name, createdAt: new Date().toISOString(), raws: [] };
  await r2PutJson("projects/" + id + ".json", project);
  const idx = await readIndex();
  idx.projects.push({ id, name, createdAt: project.createdAt });
  await writeIndex(idx);
  return { project };
}

async function actRename(p){
  const name = String(p.name||"").trim();
  if(!name) throw new Error("Nome mancante.");
  const project = await r2GetJson("projects/" + p.projectId + ".json");
  if(!project) throw new Error("Progetto non trovato.");
  project.name = name;
  await r2PutJson("projects/" + project.id + ".json", project);
  const idx = await readIndex();
  const e = (idx.projects||[]).find(x=>x.id===project.id); if(e) e.name = name;
  await writeIndex(idx);
  return { project };
}

async function actGet(p){
  const project = await r2GetJson("projects/" + p.projectId + ".json");
  if(!project) throw new Error("Progetto non trovato.");
  return { project };
}

async function actAddRaw(p){
  const project = await r2GetJson("projects/" + p.projectId + ".json");
  if(!project) throw new Error("Progetto non trovato.");
  const driveFileId = parseDriveId(p.link);
  if(!driveFileId) throw new Error("Link o ID Drive non valido.");
  const meta = await driveMeta(driveFileId); // best-effort: nome vero del video
  const order = (project.raws||[]).reduce((m,r)=>Math.max(m, r.order||0), 0) + 1;
  const raw = { id: newId("raw-"), driveFileId, link: String(p.link||"").trim(), name: meta.name || null, sizeMB: meta.sizeMB || null, order, status: "queued" };
  project.raws = project.raws || [];
  project.raws.push(raw);
  await r2PutJson("projects/" + project.id + ".json", project);
  return { project };
}

async function actReorderRaw(p){
  const project = await r2GetJson("projects/" + p.projectId + ".json");
  if(!project) throw new Error("Progetto non trovato.");
  const raws = ordered(project.raws);
  const i = raws.findIndex(r=>r.id===p.rawId);
  if(i<0) throw new Error("Grezzo non trovato.");
  const j = p.direction==="up" ? i-1 : i+1;
  if(j<0 || j>=raws.length) return { project };
  const t = raws[i].order; raws[i].order = raws[j].order; raws[j].order = t;
  project.raws = raws;
  await r2PutJson("projects/" + project.id + ".json", project);
  return { project };
}

async function actDeleteRaw(p){
  const project = await r2GetJson("projects/" + p.projectId + ".json");
  if(!project) throw new Error("Progetto non trovato.");
  project.raws = (project.raws||[]).filter(r=>r.id!==p.rawId);
  await r2PutJson("projects/" + project.id + ".json", project);
  return { project };
}

async function actDeleteProject(p){
  // pulizia: cancella le trascrizioni/errori dei grezzi, poi il progetto
  const project = await r2GetJson("projects/" + p.projectId + ".json");
  if(project){
    for(const r of (project.raws||[])){
      try{ await r2Delete("transcripts/" + r.driveFileId + ".json"); }catch(_){}
      try{ await r2Delete("errors/" + r.driveFileId + ".json"); }catch(_){}
      try{ await r2Delete("analyses/" + r.driveFileId + ".json"); }catch(_){}
      try{ await r2Delete("proxies/" + r.driveFileId + ".mp4"); }catch(_){}
    }
  }
  await r2Delete("projects/" + p.projectId + ".json");
  const idx = await readIndex();
  idx.projects = (idx.projects||[]).filter(x=>x.id!==p.projectId);
  await writeIndex(idx);
  return { ok: true };
}

async function actStatus(p){
  const id = p.driveFileId;
  if(!id) throw new Error("driveFileId mancante.");
  if(await r2Exists("transcripts/" + id + ".json")) return { status: "ready" };
  const e = await r2Fetch("GET", "errors/" + id + ".json", "");
  if(e.ok){ let msg=""; try{ msg=(await e.json()).error||""; }catch(_){}; return { status:"error", error: msg }; }
  return { status: "working" };
}

async function actTranscript(p){
  const id = p.driveFileId;
  if(!id) throw new Error("driveFileId mancante.");
  const data = await r2GetJson("transcripts/" + id + ".json");
  if(!data) throw new Error("Trascrizione non ancora disponibile.");
  return { transcript: data };
}

exports.handler = async (event) => {
  if(event.httpMethod !== "POST") return { statusCode:405, body:"Method not allowed" };
  let p; try { p = JSON.parse(event.body||"{}"); } catch(_){ return { statusCode:400, body: JSON.stringify({error:"JSON non valido"}) }; }
  try {
    let out;
    switch(p.action){
      case "list":          out = await actList(); break;
      case "summaries":     out = await actSummaries(); break;
      case "create":        out = await actCreate(p); break;
      case "rename":        out = await actRename(p); break;
      case "get":           out = await actGet(p); break;
      case "addRaw":        out = await actAddRaw(p); break;
      case "reorderRaw":    out = await actReorderRaw(p); break;
      case "deleteRaw":     out = await actDeleteRaw(p); break;
      case "deleteProject": out = await actDeleteProject(p); break;
      case "status":        out = await actStatus(p); break;
      case "transcript":    out = await actTranscript(p); break;
      case "approve":       out = await actApprove(p); break;
      case "proxyStatus":   out = await actProxyStatus(p); break;
      case "proxyUrl":      out = await actProxyUrl(p); break;
      default: return { statusCode:400, body: JSON.stringify({error:"Azione sconosciuta: "+p.action}) };
    }
    return { statusCode:200, headers:{"Content-Type":"application/json"}, body: JSON.stringify(out) };
  } catch(e){
    return { statusCode:500, headers:{"Content-Type":"application/json"}, body: JSON.stringify({error:String((e&&e.message)||e)}) };
  }
};
