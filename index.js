import express from "express";
// ---- simple in-memory concurrency limiter (prevents ffmpeg RAM/CPU spikes)
const MAX_CONCURRENT_BATCHES = Number(process.env.MAX_CONCURRENT_BATCHES || 1);
let activeBatches = 0;
function tryAcquireBatch() {
  if (activeBatches >= MAX_CONCURRENT_BATCHES) return false;
  activeBatches += 1;
  return true;
}
function releaseBatch() {
  activeBatches = Math.max(0, activeBatches - 1);
}

// ---- In-memory job store + FIFO queue (keeps UI snappy; avoids long-running HTTP requests)
const jobs = new Map();
const jobQueue = [];

function createJob({ batchId, payload }) {
  const job = {
    ok: true,
    batchId,
    status: "queued", // queued | processing | done | error
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payload,
    results: [],
    errors: [],
    csv_url: null,
    zip_url: null,
    level: payload.level || "1",
    noCaptionMode: !!payload.noCaptionMode,
    theme: payload.theme || "snus",
    count: 0,
  };
  jobs.set(batchId, job);
  return job;
}

function enqueueJob(batchId) {
  jobQueue.push(batchId);
  // kick worker loop
  void processQueue();
}

let queueLoopRunning = false;
async function processQueue() {
  if (queueLoopRunning) return;
  queueLoopRunning = true;

  try {
    while (jobQueue.length > 0) {
      // respect MAX_CONCURRENT_BATCHES via existing limiter
      if (!tryAcquireBatch()) break;

      const batchId = jobQueue.shift();
      const job = jobs.get(batchId);
      if (!job) {
        releaseBatch();
        continue;
      }

      // run job without blocking the queue loop
      void processOneJob(job)
        .catch((e) => {
          console.error("[queue] job crashed", batchId, e);
        })
        .finally(() => {
          releaseBatch();
          // kick again in case there are more jobs waiting
          void processQueue();
        });
    }
  } finally {
    queueLoopRunning = false;
  }
}

import multer from "multer";
import cors from "cors";
import os from "os";
import path from "path";
import fs from "fs/promises";
import fssync from "fs";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { nanoid } from "nanoid";
import { createClient } from "@supabase/supabase-js";

import { makeBatchCaptions } from "./captions.js";
import { toCsv } from "./csv.js";

const app = express();

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

app.use(express.json({ limit: "2mb" }));

const UPLOADS_DIR = path.join(os.tmpdir(), "content-molle-uploads");
await fs.mkdir(UPLOADS_DIR, { recursive: true });

// ---- CORS (FIX)
const allowedOrigins = new Set([
  "https://europepush.com",
  "https://www.europepush.com",
]);
const base44Regex = /^https:\/\/preview-sandbox--.*\.base44\.app$/;

app.use(
  cors({
    origin: (origin, callback) => {
      console.log("[CORS] origin:", origin);

      // Allow server-to-server & tools like curl/postman
      if (!origin) return callback(null, true);

      if (allowedOrigins.has(origin)) return callback(null, true);
      if (base44Regex.test(origin)) return callback(null, true);

      // Not allowed -> no CORS headers (browser will block)
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);

// Preflight
app.options("*", cors());

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "outputs";
const SUPABASE_INPUT_BUCKET = process.env.SUPABASE_INPUT_BUCKET || "inputs";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("[WARN] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

// Health
app.get("/", (req, res) => res.json({ ok: true, service: "content-molle" }));

// Upload handler (disk-based to avoid RAM spikes)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safeName = (file.originalname || "video")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 80);
      cb(null, `${Date.now()}_${nanoid(8)}_${safeName}`);
    },
  }),
  limits: {
    files: 20,
    // keep a per-file cap as a safety net; adjust later if needed
    fileSize: 200 * 1024 * 1024,
  },
});

// ---- Main endpoint: batch mode (1–20)
app.post("/molle", upload.array("videos", 20), async (req, res) => {
  try {
    if (!tryAcquireBatch()) {
      return res
        .status(429)
        .json({
          ok: false,
          error: "busy",
          message: "Server is processing another batch. Try again in a moment.",
        });
    }
    if (!supabase)
      return res
        .status(500)
        .json({ ok: false, error: "supabase_not_configured" });

    const files = req.files || [];

    // Defensive: ensure disk paths exist
    for (const f of files) {
      if (!f.path) {
        return res
          .status(400)
          .json({ ok: false, error: "upload_missing_path" });
      }
    }

    if (!files.length)
      return res.status(400).json({ ok: false, error: "no_videos_uploaded" });

    // Settings from form-data
    const noCaptionMode = req.body.noCaptionMode === "true";
    const level = req.body.level || "1"; // only 1 supported right now
    const theme = (req.body.theme || "snus").trim();
    const maxCount = Math.min(files.length, 20);

    const batchId = `batch_${nanoid(10)}`;
    const tmpDir = path.join(os.tmpdir(), batchId);
    await fs.mkdir(tmpDir, { recursive: true });

    const captionsPack = makeBatchCaptions({
      count: maxCount,
      noCaptionMode,
      theme,
    });

    const results = [];

    for (let i = 0; i < maxCount; i++) {
      const f = files[i];
      // multer diskStorage provides a file path on disk
      const inputPath = f.path;
      const outPath = path.join(tmpDir, `out_${i}.mp4`);

      // Level-1: tiny visual fingerprint changes, audio copied
      await runFfmpegLevel1({ inputPath, outPath });

      const outBuf = await fs.readFile(outPath);

      // Upload mp4 to Supabase Storage
      const objectPath = `batches/${batchId}/clip_${String(i + 1).padStart(
        2,
        "0"
      )}.mp4`;
      const publicUrl = await uploadToSupabase(objectPath, outBuf, "video/mp4");

      const cap = captionsPack.items[i]; // { caption, hashtags[] }
      results.push({
        idx: i,
        input_name: f.originalname,
        output_url: publicUrl,
        caption: cap.caption,
        hashtags: cap.hashtags,
      });

      // Cleanup temp files to reduce disk usage
      try {
        await fs.unlink(inputPath);
      } catch {}
      try {
        await fs.unlink(outPath);
      } catch {}
    }

    // CSV upload
    const csv = toCsv(results);
    const csvPath = `batches/${batchId}/captions.csv`;
    const csvUrl = await uploadToSupabase(
      csvPath,
      Buffer.from(csv, "utf8"),
      "text/csv"
    );

    return res.json({
      ok: true,
      batchId,
      level,
      noCaptionMode,
      theme,
      count: results.length,
      csv_url: csvUrl,
      zip_url: null,
      results,
    });
  } catch (err) {
    console.error("[/molle] error:", err);
    res
      .status(500)
      .json({ ok: false, error: "internal_error", message: err.message });
  } finally {
    releaseBatch();
  }
});

// ---- Alternative endpoint: enqueue processing of already-uploaded files from Supabase Storage (browser uploads directly)
// Body: { paths: string[], noCaptionMode?: boolean|string, level?: string, theme?: string }
app.post("/molle-from-storage", async (req, res) => {
  try {
    if (!supabase)
      return res
        .status(500)
        .json({ ok: false, error: "supabase_not_configured" });

    const body = req.body || {};
    const paths = Array.isArray(body.paths) ? body.paths : [];

    console.log("[/molle-from-storage] received paths:", paths.length, paths[0]);

    if (!paths.length)
      return res.status(400).json({ ok: false, error: "no_paths_provided" });

    const maxCount = Math.min(paths.length, 20);

    const noCaptionMode =
      body.noCaptionMode === true || body.noCaptionMode === "true";
    const level = body.level || "1";
    const theme = (body.theme || "snus").trim();

    const batchId = `batch_${nanoid(10)}`;

    createJob({
      batchId,
      payload: {
        paths: paths.slice(0, maxCount),
        noCaptionMode,
        level,
        theme,
      },
    });

    enqueueJob(batchId);

    // Return immediately (no long-running request)
    return res.status(202).json({
      ok: true,
      batchId,
      status: "queued",
      message: "Batch queued for processing",
    });
  } catch (err) {
    console.error("[/molle-from-storage] enqueue error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", message: err.message });
  }
});

// Job status polling endpoint
app.get("/batch/:batchId", (req, res) => {
  const { batchId } = req.params;
  const job = jobs.get(batchId);
  if (!job) return res.status(404).json({ ok: false, error: "not_found" });

  // return without payload to avoid leaking internal details
  const {
    payload, // eslint-disable-line no-unused-vars
    ...publicJob
  } = job;

  return res.json(publicJob);
});

async function processOneJob(job) {
  job.status = "processing";
  job.progress = 0;
  job.updatedAt = Date.now();

  const { paths } = job.payload;
  const maxCount = Math.min(paths.length, 20);

  const noCaptionMode = !!job.payload.noCaptionMode;
  const level = job.payload.level || "1";
  const theme = (job.payload.theme || "snus").trim();

  const batchId = job.batchId;

  const tmpDir = path.join(os.tmpdir(), batchId);
  await fs.mkdir(tmpDir, { recursive: true });

  const captionsPack = makeBatchCaptions({
    count: maxCount,
    noCaptionMode,
    theme,
  });

  const results = [];
  const errors = [];

  for (let i = 0; i < maxCount; i++) {
    const storagePath = String(paths[i] || "").trim();
    if (!storagePath) {
      errors.push({
        idx: i,
        input_path: storagePath,
        stage: "validate",
        message: "invalid_path",
      });
      job.progress = Math.round(((i + 1) / maxCount) * 100);
      job.updatedAt = Date.now();
      continue;
    }

    const inputPath = path.join(tmpDir, `in_${i}.mp4`);
    const outPath = path.join(tmpDir, `out_${i}.mp4`);

    try {
      console.log(
        `[molle-from-storage] (${i + 1}/${maxCount}) download start`,
        storagePath
      );
      await withTimeout(
        downloadFromSupabaseInputs(storagePath, inputPath),
        120000,
        "download_timeout"
      );
      console.log(
        `[molle-from-storage] (${i + 1}/${maxCount}) download done`,
        inputPath
      );

      console.log(
        `[molle-from-storage] (${i + 1}/${maxCount}) ffmpeg start`,
        inputPath
      );
      await withTimeout(
        runFfmpegLevel1({ inputPath, outPath }),
        240000,
        "ffmpeg_timeout"
      );
      console.log(
        `[molle-from-storage] (${i + 1}/${maxCount}) ffmpeg done`,
        outPath
      );

      console.log(
        `[molle-from-storage] (${i + 1}/${maxCount}) upload start`,
        outPath
      );

      const objectPath = `batches/${batchId}/clip_${String(i + 1).padStart(
        2,
        "0"
      )}.mp4`;

      // Stream upload (avoids loading whole MP4 into RAM)
      const publicUrl = await withTimeout(
        uploadFileStreamToSupabase(objectPath, outPath, "video/mp4"),
        180000,
        "upload_timeout"
      );

      console.log(
        `[molle-from-storage] (${i + 1}/${maxCount}) upload done`,
        publicUrl
      );

      const cap = captionsPack.items[i];
      results.push({
        idx: i,
        input_name: path.basename(storagePath),
        input_path: storagePath,
        output_url: publicUrl,
        caption: cap.caption,
        hashtags: cap.hashtags,
      });
    } catch (e) {
      console.error(
        `[molle-from-storage] (${i + 1}/${maxCount}) error`,
        storagePath,
        e
      );
      errors.push({
        idx: i,
        input_path: storagePath,
        stage: String(e?.message || "error"),
        message: String(e?.message || e),
      });
    } finally {
      // Cleanup temp files
      try {
        await fs.unlink(inputPath);
      } catch {}
      try {
        await fs.unlink(outPath);
      } catch {}

      job.progress = Math.round(((i + 1) / maxCount) * 100);
      job.updatedAt = Date.now();
    }
  }

  // CSV upload (small -> buffer is fine)
  const csv = toCsv(results);
  const csvPath = `batches/${batchId}/captions.csv`;
  const csvUrl = await uploadToSupabase(
    csvPath,
    Buffer.from(csv, "utf8"),
    "text/csv"
  );

  job.results = results;
  job.errors = errors;
  job.csv_url = csvUrl;
  job.level = level;
  job.noCaptionMode = noCaptionMode;
  job.theme = theme;
  job.count = results.length;
  job.zip_url = null;
  job.status = errors.length && results.length === 0 ? "error" : "done";
  job.progress = 100;
  job.updatedAt = Date.now();

  // Cleanup temp dir (best effort)
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {}
}

async function downloadFromSupabaseInputs(objectPath, destPath) {
  const { data, error } = await supabase.storage
    .from(SUPABASE_INPUT_BUCKET)
    .download(objectPath);

  if (error) throw error;
  if (!data) throw new Error("supabase_download_no_data");

  // In Node, Supabase returns a Blob. Stream it to disk to avoid RAM spikes.
  if (typeof data.stream === "function") {
    await pipeline(data.stream(), createWriteStream(destPath));
    return;
  }

  // Fallback (should rarely happen)
  const ab = await data.arrayBuffer();
  const buf = Buffer.from(ab);
  await fs.writeFile(destPath, buf);
}

async function uploadToSupabase(objectPath, buffer, contentType) {
  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(objectPath, buffer, { contentType, upsert: true });

  if (error) throw error;

  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
}

// Stream upload to Supabase Storage (avoids RAM spikes from fs.readFile on big mp4s)
async function uploadFileStreamToSupabase(objectPath, filePath, contentType) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("supabase_not_configured");
  }

  // Supabase Storage upload endpoint
  const url = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`;

  const stream = fssync.createReadStream(filePath);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": contentType,
      "x-upsert": "true",
    },
    // Node 18+ (undici) requires duplex when streaming request bodies
    duplex: "half",
    body: stream,
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`supabase_stream_upload_failed status=${resp.status} ${txt}`);
  }

  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
}

function runFfmpegLevel1({ inputPath, outPath }) {
  const vf =
    // keep tiktok format, but use cheaper scaling (bilinear) to reduce CPU
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=bilinear," +
    "pad=1080:1920:(1080-iw)/2:(1920-ih)/2," +
    // tiny eq for fingerprint change (lightweight)
    "eq=contrast=1.012:saturation=1.006:brightness=0.004";

  const baseArgs = [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-i",
    inputPath,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "superfast",
    "-crf",
    "23",
    "-threads",
    "2",
    "-movflags",
    "+faststart",
  ];

  function spawnFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, args);
      let stderr = "";
      ff.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      ff.on("error", reject);
      ff.on("close", (code) => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg_failed code=${code}\n${stderr.slice(-3000)}`));
      });
    });
  }

  // Try to copy audio (fast). If it fails (weird inputs), fallback to AAC.
  const tryCopyAudio = [...baseArgs, "-c:a", "copy", outPath];
  const fallbackAac = [...baseArgs, "-c:a", "aac", "-b:a", "128k", outPath];

  return spawnFfmpeg(tryCopyAudio).catch(() => spawnFfmpeg(fallbackAac));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

app.listen(PORT, () => console.log(`✅ ContentMølle backend on :${PORT}`));