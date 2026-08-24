// APP DI MONTAGGIO — API PROGETTI (funzione sincrona, non background)
// Gestisce i "progetti" salvati su Cloudflare R2. Un solo file, tante azioni.
//
// Riceve POST { action, ... } e risponde JSON. Azioni:
//   - "list"          -> elenco progetti (legge projects/_index.json)
//   - "create"        { name }                       -> crea un progetto
//   - "get"           { projectId }                  -> legge un progetto completo
//   - "addRaw"        { projectId, link }            -> aggiunge un grezzo (dal link Drive)
//   - "reorderRaw"    { projectId, rawId, direction } -> sposta un grezzo su/giu
//   - "deleteRaw"     { projectId, rawId }            -> rimuove un grezzo dal progetto
//   - "deleteProject" { projectId }                  -> cancella l'intero progetto
//
// Struttura dati su R2:
//   projects/_index.json         -> { projects: [ { id, name, createdAt } ] }
//   projects/<id>.json           -> { id, name, createdAt, raws: [ { id, driveFileId, link, name, order, status } ] }
//   (le trascrizioni restano in transcripts/<driveFileId>.json, gestite dall'altra function)
//
// Variabili: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET.

const crypto = require("crypto");

// ---------- utilita' ----------
function newId(prefix){ return (prefix||"") + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex"); }

// Estrae l'ID file da un link Drive (o accetta un ID gia' pulito).
function parseDriveId(input){
  const s = String(input || "").trim();
  let m = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);      // .../file/d/ID/view
  if(m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);              // ...?id=ID
  if(m) return m[1];
  if(/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;         // gia' un ID
  return null;
}

// ---------- R2 (firma AWS SigV4, senza librerie) ----------
function hmac(key, str){ return crypto.createHmac("sha256", key).update(str, "utf8").digest(); }
function sha256hex(str){ return crypto.createHash("sha256").update(str, "utf8").digest("hex"); }

async function r2Fetch(method, key, bodyString){
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint  = process.env.R2_ENDPOINT;
  const bucket    = process.env.R2_BUCKET;
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
  const kDate = hmac("AWS4" + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = algorithm + " Credential=" + accessKey + "/" + credentialScope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
  const headers = { "Authorization": authorization, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  if(method === "PUT") headers["Content-Type"] = "application/json";
  return fetch(endpoint + canonicalUri, { method, headers, body: (method === "PUT" ? payload : undefined) });
}

async function r2GetJson(key){
  const res = await r2Fetch("GET", key, "");
  if(res.status === 404) return null;
  if(!res.ok) throw new Error("R2 get " + res.status + " " + (await res.text()).slice(0,140));
  return res.json();
}
async function r2PutJson(key, obj){
  const res = await r2Fetch("PUT", key, JSON.stringify(obj, null, 2));
  if(!res.ok) throw new Error("R2 put " + res.status + " " + (await res.text()).slice(0,140));
  return true;
}
async function r2Delete(key){
  const res = await r2Fetch("DELETE", key, "");
  if(!res.ok && res.status !== 404) throw new Error("R2 del " + res.status + " " + (await res.text()).slice(0,140));
  return true;
}

// ---------- indice progetti ----------
const INDEX_KEY = "projects/_index.json";
async function readIndex(){ return (await r2GetJson(INDEX_KEY)) || { projects: [] }; }
async function writeIndex(idx){ return r2PutJson(INDEX_KEY, idx); }

// ---------- azioni ----------
async function actList(){
  const idx = await readIndex();
  // ordina per data di creazione, piu' recenti prima
  const list = (idx.projects || []).slice().sort(function(a,b){ return (b.createdAt||"").localeCompare(a.createdAt||""); });
  return { projects: list };
}

async function actCreate(p){
  const name = String(p.name || "").trim();
  if(!name) throw new Error("Nome progetto mancante.");
  const id = newId("prj-");
  const project = { id, name, createdAt: new Date().toISOString(), raws: [] };
  await r2PutJson("projects/" + id + ".json", project);
  const idx = await readIndex();
  idx.projects.push({ id, name, createdAt: project.createdAt });
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
  const order = (project.raws || []).reduce(function(m,r){ return Math.max(m, r.order||0); }, 0) + 1;
  const raw = { id: newId("raw-"), driveFileId, link: String(p.link||"").trim(), name: p.name || null, order, status: "queued" };
  project.raws = project.raws || [];
  project.raws.push(raw);
  await r2PutJson("projects/" + project.id + ".json", project);
  return { project };
}

async function actReorderRaw(p){
  const project = await r2GetJson("projects/" + p.projectId + ".json");
  if(!project) throw new Error("Progetto non trovato.");
  const raws = (project.raws || []).slice().sort(function(a,b){ return (a.order||0)-(b.order||0); });
  const i = raws.findIndex(function(r){ return r.id === p.rawId; });
  if(i < 0) throw new Error("Grezzo non trovato.");
  const j = p.direction === "up" ? i-1 : i+1;
  if(j < 0 || j >= raws.length) return { project }; // gia' agli estremi
  const tmp = raws[i].order; raws[i].order = raws[j].order; raws[j].order = tmp;
  project.raws = raws;
  await r2PutJson("projects/" + project.id + ".json", project);
  return { project };
}

async function actDeleteRaw(p){
  const project = await r2GetJson("projects/" + p.projectId + ".json");
  if(!project) throw new Error("Progetto non trovato.");
  project.raws = (project.raws || []).filter(function(r){ return r.id !== p.rawId; });
  await r2PutJson("projects/" + project.id + ".json", project);
  return { project };
}

async function actStatus(p){
  const id = p.driveFileId;
  if(!id) throw new Error("driveFileId mancante.");
  const t = await r2Fetch("GET", "transcripts/" + id + ".json", "");
  if(t.ok) return { status: "ready" };
  const e = await r2Fetch("GET", "errors/" + id + ".json", "");
  if(e.ok){ let msg = ""; try { msg = (await e.json()).error || ""; } catch(_){}; return { status: "error", error: msg }; }
  return { status: "working" };
}

async function actTranscript(p){
  const id = p.driveFileId;
  if(!id) throw new Error("driveFileId mancante.");
  const data = await r2GetJson("transcripts/" + id + ".json");
  if(!data) throw new Error("Trascrizione non ancora disponibile.");
  return { transcript: data };
}

async function actDeleteProject(p){
  await r2Delete("projects/" + p.projectId + ".json");
  const idx = await readIndex();
  idx.projects = (idx.projects || []).filter(function(x){ return x.id !== p.projectId; });
  await writeIndex(idx);
  return { ok: true };
}

exports.handler = async (event) => {
  if(event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  let p; try { p = JSON.parse(event.body || "{}"); } catch(_){ return { statusCode: 400, body: JSON.stringify({ error: "JSON non valido" }) }; }
  try {
    let out;
    switch(p.action){
      case "list":          out = await actList(); break;
      case "create":        out = await actCreate(p); break;
      case "get":           out = await actGet(p); break;
      case "addRaw":        out = await actAddRaw(p); break;
      case "reorderRaw":    out = await actReorderRaw(p); break;
      case "deleteRaw":     out = await actDeleteRaw(p); break;
      case "status":        out = await actStatus(p); break;
      case "transcript":    out = await actTranscript(p); break;
      case "deleteProject": out = await actDeleteProject(p); break;
      default: return { statusCode: 400, body: JSON.stringify({ error: "Azione sconosciuta: " + p.action }) };
    }
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) };
  } catch(e){
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
