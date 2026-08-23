// APP DI MONTAGGIO — PEZZO 1 (versione definitiva, app separata)
// Netlify BACKGROUND function.
//
// Riceve { driveFileId } = l'ID su Google Drive del VIDEO GREZZO.
// - Legge i metadati del video (nome, dimensione, cartella genitore).
// - Crea (o riusa) una sottocartella "Trascrizioni" ACCANTO al video.
// - Scarica il video in streaming su /tmp (regge anche i file pesanti).
// - Estrae l'audio con FFmpeg.
// - Trascrive con Whisper chiedendo i TIMESTAMP per PAROLA e per SEGMENTO.
// - Salva il JSON completo (testo + parole + segmenti, con start/end) in "Trascrizioni".
// In caso di errore scrive un piccolo file "... — ERRORE.json" nella stessa cartella,
// cosi' vedi cosa non ha funzionato senza aprire i log di Netlify.
//
// Nessun legame con Google Calendar: questa app e' indipendente da Palinsesto.
// Variabili d'ambiente: GOOGLE_SA_JSON, OPENAI_API_KEY.
// NOME FILE: deve finire con "-background" perche' Netlify le dia i 15 minuti.

const crypto = require("crypto");
const fs = require("fs");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const ffmpegPath = require("ffmpeg-static");

// Al nuovo tool serve solo Drive (niente Calendar).
const SCOPE = "https://www.googleapis.com/auth/drive";
const OUTPUT_SUBFOLDER = "Trascrizioni";

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

async function gDrive(token, path){
  const res = await fetch("https://www.googleapis.com/drive/v3" + path, { headers:{ "Authorization":"Bearer "+token } });
  if(!res.ok) throw new Error("Drive " + res.status + " " + (await res.text()).slice(0,140));
  return res.json();
}

// Metadati del video: nome, dimensione, cartella genitore, tipo.
async function getFileMeta(token, fileId){
  const p = new URLSearchParams({ fields:"id,name,size,parents,mimeType", supportsAllDrives:"true" });
  return gDrive(token, "/files/" + encodeURIComponent(fileId) + "?" + p.toString());
}

async function findFolder(token, name, parentId){
  const safe = String(name).replace(/'/g, "\\'");
  const q = `name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;
  const p = new URLSearchParams({ q, fields:"files(id)", includeItemsFromAllDrives:"true", supportsAllDrives:"true", pageSize:"1" });
  const d = await gDrive(token, "/files?" + p.toString());
  return (d.files && d.files[0]) ? d.files[0].id : null;
}

// Trova la sottocartella, o la crea se non c'e'.
async function findOrCreateFolder(token, name, parentId){
  const existing = await findFolder(token, name, parentId);
  if(existing) return existing;
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
    method:"POST",
    headers:{ "Authorization":"Bearer "+token, "Content-Type":"application/json" },
    body: JSON.stringify({ name, mimeType:"application/vnd.google-apps.folder", parents:[parentId] })
  });
  if(!res.ok) throw new Error("Drive mkdir " + res.status + " " + (await res.text()).slice(0,140));
  const d = await res.json();
  return d.id;
}

function runFfmpeg(inPath, outPath){
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ["-y", "-i", inPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", outPath]);
    let err = "";
    ff.stderr.on("data", (d)=>{ err += d.toString(); });
    ff.on("error", reject);
    ff.on("close", (code)=> code === 0 ? resolve() : reject(new Error("ffmpeg " + code + ": " + err.slice(-200))));
  });
}

// Whisper verbose_json con timestamp per parola e per segmento.
async function whisperVerbose(audioPath){
  const key = process.env.OPENAI_API_KEY;
  const buf = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type:"audio/mpeg" }), "audio.mp3");
  form.append("model", "whisper-1");
  form.append("language", "it");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method:"POST", headers:{ "Authorization":"Bearer "+key }, body: form });
  const d = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error("Whisper " + res.status + " " + JSON.stringify(d).slice(0,140));
  return d;
}

// Carica un oggetto JSON come file su Drive (multipart) e restituisce l'ID del file creato.
async function uploadJsonToDrive(token, parentId, name, obj){
  const boundary = "boundary_" + crypto.randomBytes(8).toString("hex");
  const metadata = { name, parents: [parentId], mimeType: "application/json" };
  const body =
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: application/json\r\n\r\n" +
    JSON.stringify(obj) + "\r\n" +
    "--" + boundary + "--";
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name", {
    method: "POST",
    headers: { "Authorization":"Bearer "+token, "Content-Type": "multipart/related; boundary=" + boundary },
    body
  });
  if(!res.ok) throw new Error("Drive upload " + res.status + " " + (await res.text()).slice(0,140));
  const d = await res.json();
  return d.id;
}

exports.handler = async (event) => {
  let body; try { body = JSON.parse(event.body || "{}"); } catch(_){ return { statusCode:400 }; }
  const driveFileId = body.driveFileId;
  if(!driveFileId) return { statusCode:400 };

  const vid = "/tmp/grezzo_" + Date.now() + ".mp4";
  const aud = "/tmp/grezzo_" + Date.now() + ".mp3";
  let token, outFolderId, baseName = "video";
  try {
    const sa = JSON.parse(process.env.GOOGLE_SA_JSON);
    token = await getSaToken(sa, SCOPE);

    // 1) Metadati del video + cartella dove salvare l'output.
    const meta = await getFileMeta(token, driveFileId);
    if(!meta || !meta.id) throw new Error("File Drive non trovato: " + driveFileId);
    if(!String(meta.mimeType||"").startsWith("video/")) throw new Error("Il file non e' un video (" + meta.mimeType + ").");
    baseName = String(meta.name || "video").replace(/\.[^.]+$/, "");
    const parentId = (meta.parents && meta.parents[0]) ? meta.parents[0] : null;
    if(!parentId) throw new Error("Il video non ha una cartella genitore accessibile.");
    outFolderId = await findOrCreateFolder(token, OUTPUT_SUBFOLDER, parentId);

    // 2) Download in streaming.
    console.log("Scarico il video (" + (meta.size ? Math.round(meta.size/1048576)+" MB" : "?") + ")...");
    const dl = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(driveFileId) + "?alt=media&supportsAllDrives=true", { headers:{ "Authorization":"Bearer "+token } });
    if(!dl.ok || !dl.body) throw new Error("Download video " + dl.status);
    await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(vid));

    // 3) Estrai audio.
    console.log("Estraggo l'audio...");
    await runFfmpeg(vid, aud);
    try { fs.unlinkSync(vid); } catch(_){}

    // 4) Limite Whisper (~25 MB; a 5 min sei intorno ai 2-3 MB).
    const sizeMB = fs.statSync(aud).size / 1048576;
    console.log("Audio " + sizeMB.toFixed(2) + " MB -> Whisper...");
    if(sizeMB > 24.5) throw new Error("Audio troppo lungo per la trascrizione (oltre ~24 MB, ~50 min).");

    // 5) Trascrizione con timestamp.
    const v = await whisperVerbose(aud);
    try { fs.unlinkSync(aud); } catch(_){}
    const text = (v.text || "").trim();
    if(!text) throw new Error("Trascrizione vuota.");
    const words = Array.isArray(v.words) ? v.words : [];
    const segments = Array.isArray(v.segments) ? v.segments : [];

    // 6) JSON completo salvato nella sottocartella "Trascrizioni".
    const transcriptObj = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: { driveFileId, name: meta.name, sizeMB: meta.size ? +(meta.size/1048576).toFixed(1) : null },
      language: v.language || "it",
      duration: v.duration || null,
      text,
      segments: segments.map(function(s){ return { id: s.id, start: s.start, end: s.end, text: (s.text||"").trim() }; }),
      words: words.map(function(w){ return { word: w.word, start: w.start, end: w.end }; }),
    };
    const jsonName = baseName + " - trascrizione.json";
    const fileId = await uploadJsonToDrive(token, outFolderId, jsonName, transcriptObj);
    console.log("OK: " + words.length + " parole, " + segments.length + " segmenti -> " + jsonName + " (" + fileId + ")");
    return { statusCode:200 };
  } catch(e){
    try { fs.unlinkSync(vid); } catch(_){}
    try { fs.unlinkSync(aud); } catch(_){}
    const msg = String((e && e.message) || e).slice(0, 300);
    console.log("ERRORE:", msg);
    // Marcatore d'errore su Drive (best-effort), se abbiamo gia' la cartella.
    try { if(token && outFolderId){ await uploadJsonToDrive(token, outFolderId, baseName + " - ERRORE.json", { error: msg, at: new Date().toISOString(), driveFileId }); } } catch(_){}
    return { statusCode:500 };
  }
};
