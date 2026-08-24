// APP DI MONTAGGIO — PEZZO 1 (salvataggio su Cloudflare R2)
// Netlify BACKGROUND function.
//
// Riceve { driveFileId } = l'ID su Google Drive del VIDEO GREZZO.
// - FFmpeg legge il video DIRETTAMENTE dall'URL di Drive (range request):
//   gestisce qualunque formato e NON scarica il video intero (regge i file grossi).
//   A terra finisce solo l'audio .mp3 mono 16kHz.
// - Trascrive con Whisper (timestamp per parola e per segmento).
// - Salva il JSON su CLOUDFLARE R2 (nessun problema di quota/permessi come su Drive).
//   Nome file: transcripts/<driveFileId>.json  -> etichettato per progetto video,
//   cosi' in futuro un pulsante "cancella progetto" potra' eliminarlo in modo mirato.
//
// Variabili: GOOGLE_SA_JSON, OPENAI_API_KEY, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//            R2_ENDPOINT, R2_BUCKET.
// NOME FILE: deve finire con "-background".

const crypto = require("crypto");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const SCOPE = "https://www.googleapis.com/auth/drive";

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

async function getFileMeta(token, fileId){
  const p = new URLSearchParams({ fields:"id,name,size,parents,mimeType", supportsAllDrives:"true" });
  const res = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?" + p.toString(), { headers:{ "Authorization":"Bearer "+token } });
  if(!res.ok) throw new Error("Drive meta " + res.status + " " + (await res.text()).slice(0,140));
  return res.json();
}

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

// --- Firma AWS SigV4 per Cloudflare R2 (compatibile S3), senza librerie esterne ---
function hmac(key, str){ return crypto.createHmac("sha256", key).update(str, "utf8").digest(); }
function sha256hex(str){ return crypto.createHash("sha256").update(str, "utf8").digest("hex"); }

async function putToR2(objectKey, bodyString){
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint  = process.env.R2_ENDPOINT;   // https://<account>.r2.cloudflarestorage.com
  const bucket    = process.env.R2_BUCKET;

  const host = endpoint.replace(/^https?:\/\//, "");
  const region = "auto";
  const service = "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");       // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);                                 // YYYYMMDD

  const canonicalUri = "/" + bucket + "/" + objectKey.split("/").map(encodeURIComponent).join("/");
  const payloadHash = sha256hex(bodyString);
  const canonicalHeaders =
    "host:" + host + "\n" +
    "x-amz-content-sha256:" + payloadHash + "\n" +
    "x-amz-date:" + amzDate + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = dateStamp + "/" + region + "/" + service + "/aws4_request";
  const stringToSign = [ algorithm, amzDate, credentialScope, sha256hex(canonicalRequest) ].join("\n");

  const kDate = hmac("AWS4" + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization = algorithm + " Credential=" + accessKey + "/" + credentialScope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;

  const res = await fetch(endpoint + canonicalUri, {
    method: "PUT",
    headers: {
      "Authorization": authorization,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      "Content-Type": "application/json"
    },
    body: bodyString
  });
  if(!res.ok) throw new Error("R2 put " + res.status + " " + (await res.text()).slice(0,160));
  return objectKey;
}

exports.handler = async (event) => {
  let body; try { body = JSON.parse(event.body || "{}"); } catch(_){ return { statusCode:400 }; }
  const driveFileId = body.driveFileId;
  if(!driveFileId) return { statusCode:400 };

  const aud = "/tmp/grezzo_" + Date.now() + ".mp3";
  let token;
  try {
    const sa = JSON.parse(process.env.GOOGLE_SA_JSON);
    token = await getSaToken(sa, SCOPE);

    // 1) Metadati video.
    const meta = await getFileMeta(token, driveFileId);
    if(!meta || !meta.id) throw new Error("File Drive non trovato: " + driveFileId);
    if(!String(meta.mimeType||"").startsWith("video/")) throw new Error("Il file non e' un video (" + meta.mimeType + ").");

    // 2) FFmpeg legge Drive ed estrae solo l'audio.
    console.log("Estraggo l'audio da Drive (" + (meta.size ? Math.round(meta.size/1048576)+" MB" : "?") + ", " + (meta.mimeType||"?") + ")...");
    await extractAudioFromDriveUrl(token, driveFileId, aud);

    // 3) Controllo audio.
    let sizeMB = 0; try { sizeMB = fs.statSync(aud).size / 1048576; } catch(_){ sizeMB = 0; }
    console.log("Audio " + sizeMB.toFixed(2) + " MB -> Whisper...");
    if(sizeMB < 0.005) throw new Error("Audio vuoto: FFmpeg non ha estratto suono dal video.");
    if(sizeMB > 24.5) throw new Error("Audio troppo lungo per la trascrizione (oltre ~24 MB, ~50 min).");

    // 4) Trascrizione.
    const v = await whisperVerbose(aud);
    try { fs.unlinkSync(aud); } catch(_){}
    const text = (v.text || "").trim();
    if(!text) throw new Error("Trascrizione vuota.");
    const words = Array.isArray(v.words) ? v.words : [];
    const segments = Array.isArray(v.segments) ? v.segments : [];

    // 5) JSON + salvataggio su R2 (chiave etichettata per progetto video).
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
    const objectKey = "transcripts/" + driveFileId + ".json";
    await putToR2(objectKey, JSON.stringify(transcriptObj, null, 2));
    console.log("OK: " + words.length + " parole, " + segments.length + " segmenti -> R2 " + objectKey);
    return { statusCode:200 };
  } catch(e){
    try { fs.unlinkSync(aud); } catch(_){}
    const msg = String((e && e.message) || e).slice(0, 300);
    console.log("ERRORE:", msg);
    // Marcatore d'errore su R2 (best-effort).
    try { await putToR2("errors/" + driveFileId + ".json", JSON.stringify({ error: msg, at: new Date().toISOString(), driveFileId }, null, 2)); } catch(_){}
    return { statusCode:500 };
  }
};
