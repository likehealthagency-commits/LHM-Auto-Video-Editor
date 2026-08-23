// APP DI MONTAGGIO — PEZZO 1 (versione definitiva funzionante)
// Netlify BACKGROUND function.
//
// Riceve { driveFileId } = l'ID su Google Drive del VIDEO GREZZO.
// - FFmpeg legge il video DIRETTAMENTE dall'URL di Drive (range request):
//   gestisce qualunque formato e NON scarica il video intero (regge i file grossi).
//   A terra finisce solo l'audio .mp3 mono 16kHz.
// - Trascrive con Whisper (timestamp per parola e per segmento).
// - Salva il JSON nel DRIVE CONDIVISO (Shared Drive), dove il Service Account
//   ha quota e puo' creare file nuovi. Sottocartella dedicata "Montaggio - Trascrizioni".
//   (Su "Il mio Drive" di un Gmail il SA non puo' creare: no storage quota.)
// - Salvataggio "a due passi" (crea metadati -> PATCH contenuto), come fa Palinsesto.
// In caso di errore scrive un file "... - ERRORE.json" nella stessa sottocartella.
//
// Variabili: GOOGLE_SA_JSON, OPENAI_API_KEY.
// NOME FILE: deve finire con "-background".

const crypto = require("crypto");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const SCOPE = "https://www.googleapis.com/auth/drive";

// IMPORTANTE: NON si usa la radice del Drive Condiviso (0A...) come parent: il Service
// Account non e' membro dell'intero drive, quindi la radice per lui "non esiste" (404).
// Si usa invece una CARTELLA condivisa col Service Account. Qui: la "cartella madre" dei
// clienti di Palinsesto, che e' sul Drive Condiviso ed e' scrivibile dal SA.
// (In futuro, per tenere gli output separati, sostituire con l'ID di una cartella dedicata
//  creata nel Drive Condiviso e condivisa col Service Account.)
const OUTPUT_PARENT = "1e81onqkdfnzuCUi8eYmmgoYhKfTaqsHe";
// Sottocartella dedicata agli output del tool (creata al primo avvio dentro OUTPUT_PARENT).
const OUTPUT_SUBFOLDER = "Montaggio - Trascrizioni";

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

async function getFileMeta(token, fileId){
  const p = new URLSearchParams({ fields:"id,name,size,parents,mimeType", supportsAllDrives:"true" });
  return gDrive(token, "/files/" + encodeURIComponent(fileId) + "?" + p.toString());
}

// Cerca una sottocartella per nome dentro un parent, sui Drive condivisi.
async function findFolder(token, name, parentId){
  const safe = String(name).replace(/'/g, "\\'");
  const q = `name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;
  const p = new URLSearchParams({ q, fields:"files(id)", includeItemsFromAllDrives:"true", supportsAllDrives:"true", corpora:"allDrives", pageSize:"1" });
  const d = await gDrive(token, "/files?" + p.toString());
  return (d.files && d.files[0]) ? d.files[0].id : null;
}

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

// FFmpeg legge il video direttamente dall'URL di Drive ed estrae solo l'audio.
function extractAudioFromDriveUrl(token, driveFileId, outAudioPath){
  return new Promise((resolve, reject) => {
    const url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(driveFileId) + "?alt=media&supportsAllDrives=true";
    const ff = spawn(ffmpegPath, [
      "-y",
      "-headers", "Authorization: Bearer " + token + "\r\n",
      "-i", url,
      "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
      outAudioPath
    ]);
    let err = "";
    ff.stderr.on("data", (d)=>{ err += d.toString(); });
    ff.on("error", reject);
    ff.on("close", (code)=> code === 0 ? resolve() : reject(new Error("ffmpeg " + code + ": " + err.slice(-300))));
  });
}

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

// Salvataggio "a due passi" (come Palinsesto): 1) crea metadati -> fileId  2) PATCH media contenuto.
async function createJsonOnDrive(token, parentId, name, obj){
  // Passo 1: crea il file (solo metadati) sul Drive Condiviso.
  const meta = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
    method:"POST",
    headers:{ "Authorization":"Bearer "+token, "Content-Type":"application/json" },
    body: JSON.stringify({ name, mimeType:"application/json", parents:[parentId] })
  });
  if(!meta.ok) throw new Error("Drive create " + meta.status + " " + (await meta.text()).slice(0,140));
  const fileId = (await meta.json()).id;
  // Passo 2: scrivi il contenuto.
  const put = await fetch("https://www.googleapis.com/upload/drive/v3/files/" + fileId + "?uploadType=media&supportsAllDrives=true", {
    method:"PATCH",
    headers:{ "Authorization":"Bearer "+token, "Content-Type":"application/json" },
    body: JSON.stringify(obj, null, 2)
  });
  if(!put.ok) throw new Error("Drive write " + put.status + " " + (await put.text()).slice(0,140));
  return fileId;
}

exports.handler = async (event) => {
  let body; try { body = JSON.parse(event.body || "{}"); } catch(_){ return { statusCode:400 }; }
  const driveFileId = body.driveFileId;
  if(!driveFileId) return { statusCode:400 };

  const aud = "/tmp/grezzo_" + Date.now() + ".mp3";
  let token, outFolderId, baseName = "video";
  try {
    const sa = JSON.parse(process.env.GOOGLE_SA_JSON);
    token = await getSaToken(sa, SCOPE);

    // 1) Metadati del video (per nome + verifica sia un video).
    const meta = await getFileMeta(token, driveFileId);
    if(!meta || !meta.id) throw new Error("File Drive non trovato: " + driveFileId);
    if(!String(meta.mimeType||"").startsWith("video/")) throw new Error("Il file non e' un video (" + meta.mimeType + ").");
    baseName = String(meta.name || "video").replace(/\.[^.]+$/, "");

    // 2) Cartella di output dentro una cartella condivisa col SA (sul Drive Condiviso).
    outFolderId = await findOrCreateFolder(token, OUTPUT_SUBFOLDER, OUTPUT_PARENT);

    // 3) FFmpeg legge Drive direttamente ed estrae solo l'audio.
    console.log("Estraggo l'audio da Drive (" + (meta.size ? Math.round(meta.size/1048576)+" MB" : "?") + ", " + (meta.mimeType||"?") + ")...");
    await extractAudioFromDriveUrl(token, driveFileId, aud);

    // 4) Controllo audio.
    let sizeMB = 0;
    try { sizeMB = fs.statSync(aud).size / 1048576; } catch(_){ sizeMB = 0; }
    console.log("Audio " + sizeMB.toFixed(2) + " MB -> Whisper...");
    if(sizeMB < 0.005) throw new Error("Audio vuoto: FFmpeg non ha estratto suono dal video.");
    if(sizeMB > 24.5) throw new Error("Audio troppo lungo per la trascrizione (oltre ~24 MB, ~50 min).");

    // 5) Trascrizione con timestamp.
    const v = await whisperVerbose(aud);
    try { fs.unlinkSync(aud); } catch(_){}
    const text = (v.text || "").trim();
    if(!text) throw new Error("Trascrizione vuota.");
    const words = Array.isArray(v.words) ? v.words : [];
    const segments = Array.isArray(v.segments) ? v.segments : [];

    // 6) JSON completo salvato sul Drive Condiviso.
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
    const fileId = await createJsonOnDrive(token, outFolderId, jsonName, transcriptObj);
    console.log("OK: " + words.length + " parole, " + segments.length + " segmenti -> " + jsonName + " (" + fileId + ")");
    return { statusCode:200 };
  } catch(e){
    try { fs.unlinkSync(aud); } catch(_){}
    const msg = String((e && e.message) || e).slice(0, 300);
    console.log("ERRORE:", msg);
    try { if(token && outFolderId){ await createJsonOnDrive(token, outFolderId, baseName + " - ERRORE.json", { error: msg, at: new Date().toISOString(), driveFileId }); } } catch(_){}
    return { statusCode:500 };
  }
};
