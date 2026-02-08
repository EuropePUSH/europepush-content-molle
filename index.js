import "dotenv/config";
import express from "express";
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

// DEBUG: Check what we're actually reading
console.log('[DEBUG] Environment variables:');
console.log('  TEST_MODE =', process.env.TEST_MODE);
console.log('  SUPABASE_URL =', process.env.SUPABASE_URL ? 'SET' : 'NOT SET');
console.log('  SUPABASE_SERVICE_ROLE_KEY =', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SET' : 'NOT SET');

// TEST MODE: Set to 'true' to skip Supabase uploads (saves files locally instead)
const TEST_MODE = process.env.TEST_MODE === 'true';

console.log('[DEBUG] TEST_MODE parsed as:', TEST_MODE);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "outputs";
const SUPABASE_INPUT_BUCKET = process.env.SUPABASE_INPUT_BUCKET || "inputs";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("[WARN] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  if (!TEST_MODE) {
    console.warn("[WARN] Set TEST_MODE=true to test locally without Supabase");
  }
}

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

if (TEST_MODE) {
  console.log("[TEST MODE] 🧪 Running in test mode - files will be saved locally instead of Supabase");
}

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
    files: 300,
    // keep a per-file cap as a safety net; adjust later if needed
    fileSize: 200 * 1024 * 1024,
  },
});

// ---- Main endpoint: batch mode (1–300)
app.post("/molle", upload.array("videos", 300), async (req, res) => {
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
    if (!supabase && !TEST_MODE)
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
    const maxCount = Math.min(files.length, 300);
    
    // ANTI-SHADOWBAN: Number of CSV files to generate (one per account)
    const numCsvs = Math.min(parseInt(req.body.numCsvs) || 1, 50); // Max 50 CSVs

    const batchId = `batch_${nanoid(10)}`;
    const tmpDir = path.join(os.tmpdir(), batchId);
    await fs.mkdir(tmpDir, { recursive: true });

    // ANTI-SHADOWBAN: Generate enough captions for all versions (numCsvs × videos)
    const totalVideos = maxCount * numCsvs;
    const captionsPack = makeBatchCaptions({
      count: totalVideos,
      noCaptionMode,
      theme,
    });

    const results = [];

    // ANTI-SHADOWBAN: Process each video numCsvs times (creates unique versions per account)
    for (let csvIndex = 0; csvIndex < numCsvs; csvIndex++) {
      for (let i = 0; i < maxCount; i++) {
        const f = files[i];
        const inputPath = f.path;
        const globalIdx = csvIndex * maxCount + i; // Unique index across all versions
        const outPath = path.join(tmpDir, `out_csv${csvIndex}_clip${i}.mp4`);

        // Each version gets different randomization due to unique clipIndex
        await runFfmpegLevel1({ inputPath, outPath, clipIndex: globalIdx });

        const outBuf = await fs.readFile(outPath);

        // Upload mp4 to Supabase Storage
        const objectPath = `batches/${batchId}/account_${String(csvIndex + 1).padStart(2, '0')}_clip_${String(i + 1).padStart(2, "0")}.mp4`;
        const publicUrl = await uploadToSupabase(objectPath, outBuf, "video/mp4");

        // ANTI-SHADOWBAN: Each video gets unique caption from shuffled pool
        const cap = captionsPack.items[globalIdx];
        results.push({
          csvIndex,
          idx: i,
          input_name: f.originalname,
          output_url: publicUrl,
          caption: cap.caption,
          hashtags: cap.hashtags,
        });

        // Cleanup temp file
        try {
          await fs.unlink(outPath);
        } catch {}
      }
    }

    // Cleanup input files after all versions processed
    for (const f of files) {
      try {
        await fs.unlink(f.path);
      } catch {}
    }

    // ANTI-SHADOWBAN: Generate multiple CSV files (one per account with their unique videos)
    const csvUrls = [];
    
    for (let csvIndex = 0; csvIndex < numCsvs; csvIndex++) {
      // Filter results for this CSV (only videos processed for this account)
      const csvResults = results.filter(r => r.csvIndex === csvIndex);
      
      const csv = toCsv(csvResults, { shuffleOrder: true });
      const csvPath = `batches/${batchId}/captions_account_${String(csvIndex + 1).padStart(2, '0')}.csv`;
      const csvUrl = await uploadToSupabase(
        csvPath,
        Buffer.from(csv, "utf8"),
        "text/csv"
      );
      csvUrls.push({
        account: csvIndex + 1,
        url: csvUrl,
        video_count: csvResults.length
      });
    }

    return res.json({
      ok: true,
      batchId,
      level,
      noCaptionMode,
      theme,
      count: results.length,
      videos_per_account: maxCount,
      num_csvs: numCsvs,
      csv_urls: csvUrls, // Array of CSV URLs (one per account)
      csv_url: csvUrls[0]?.url || null, // Backward compatibility
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

// ---- Alternative endpoint: process already-uploaded files from Supabase Storage (browser uploads directly)
// Body: { paths: string[], noCaptionMode?: boolean|string, level?: string, theme?: string }
// Returns immediately with a batchId; client polls GET /batch/:batchId
app.post("/molle-from-storage", async (req, res) => {
  try {
    if (!supabase && !TEST_MODE)
      return res
        .status(500)
        .json({ ok: false, error: "supabase_not_configured" });

    const body = req.body || {};
    const paths = Array.isArray(body.paths) ? body.paths : [];

    console.log(
      "[/molle-from-storage] received paths:",
      paths.length,
      "first:",
      paths[0],
      "MAX_FILES:",
      Number(process.env.MAX_FILES || 0)
    );

    if (!paths.length)
      return res.status(400).json({ ok: false, error: "no_paths_provided" });

    const noCaptionMode =
      body.noCaptionMode === true || body.noCaptionMode === "true";
    const level = body.level || "1";
    const theme = (body.theme || "snus").trim();
    const numCsvs = Math.min(parseInt(body.numCsvs) || 1, 50); // Max 50 CSVs

    const batchId = `batch_${nanoid(10)}`;

    const job = createJob({
      batchId,
      payload: {
        // IMPORTANT: do NOT cap here; allow unlimited. If you want a safety cap,
        // set MAX_FILES env and slice in processOneJob.
        paths,
        noCaptionMode,
        level,
        theme,
        numCsvs,
      },
    });

    // Enqueue and return immediately (prevents Render HTTP timeouts)
    enqueueJob(batchId);

    return res.status(202).json({
      ok: true,
      batchId: job.batchId,
      status: job.status,
      queued: true,
      level: job.level,
      noCaptionMode: job.noCaptionMode,
      theme: job.theme,
      count: 0,
      message: "queued",
    });
  } catch (err) {
    console.error("[/molle-from-storage] error:", err);
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

  // Optional safety cap (0 = unlimited). If you ever see (x/20) again, it's because
  // MAX_FILES is set to 20 in Render envs.
  const MAX_FILES = Number(process.env.MAX_FILES || 0);

  const workPaths =
    MAX_FILES > 0 && paths.length > MAX_FILES ? paths.slice(0, MAX_FILES) : paths;

  const maxCount = workPaths.length;

  if (MAX_FILES > 0 && paths.length > MAX_FILES) {
    console.warn(
      `[molle-from-storage] TRUNCATED: received ${paths.length} paths, processing only ${MAX_FILES}. ` +
        `Unset MAX_FILES (or set to 0) to run unlimited.`
    );
  }

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
    const storagePath = String(workPaths[i] || "").trim();
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
        runFfmpegLevel1({ inputPath, outPath, clipIndex: i }),
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

  // ANTI-SHADOWBAN: Generate multiple CSV files (one per account with different shuffle)
  const numCsvs = job.payload.numCsvs || 1;
  const csvUrls = [];
  
  for (let csvIndex = 0; csvIndex < numCsvs; csvIndex++) {
    const csv = toCsv(results, { shuffleOrder: true });
    const csvPath = `batches/${batchId}/captions_account_${String(csvIndex + 1).padStart(2, '0')}.csv`;
    const csvUrl = await uploadToSupabase(
      csvPath,
      Buffer.from(csv, "utf8"),
      "text/csv"
    );
    csvUrls.push({
      account: csvIndex + 1,
      url: csvUrl
    });
  }

  job.results = results;
  job.errors = errors;
  job.csv_urls = csvUrls;
  job.csv_url = csvUrls[0]?.url || null; // Backward compatibility
  job.level = level;
  job.noCaptionMode = noCaptionMode;
  job.theme = theme;
  job.count = results.length;
  job.num_csvs = numCsvs;
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
  // TEST MODE: Save locally instead of uploading to Supabase
  if (TEST_MODE) {
    const localDir = path.join(os.tmpdir(), 'content-molle-test-output');
    await fs.mkdir(localDir, { recursive: true });
    
    const localPath = path.join(localDir, objectPath.replace(/\//g, '_'));
    await fs.writeFile(localPath, buffer);
    
    const mockUrl = `file:///${localPath}`;
    console.log(`[TEST MODE] Saved to: ${localPath}`);
    return mockUrl;
  }

  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(objectPath, buffer, { contentType, upsert: true });

  if (error) throw error;

  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
}

// Stream upload to Supabase Storage (avoids RAM spikes from fs.readFile on big mp4s)
async function uploadFileStreamToSupabase(objectPath, filePath, contentType) {
  // TEST MODE: Just copy file locally
  if (TEST_MODE) {
    const localDir = path.join(os.tmpdir(), 'content-molle-test-output');
    await fs.mkdir(localDir, { recursive: true });
    
    const localPath = path.join(localDir, objectPath.replace(/\//g, '_'));
    await fs.copyFile(filePath, localPath);
    
    const mockUrl = `file:///${localPath}`;
    console.log(`[TEST MODE] Saved to: ${localPath}`);
    return mockUrl;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("supabase_not_configured");
  }

  // Supabase Storage upload endpoint
  const url = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`;

  const stream = fssync.createReadStream(filePath);

  const stat = await fs.stat(filePath);

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": contentType,
      "content-length": String(stat.size),
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

function runFfmpegLevel1({ inputPath, outPath, clipIndex = 0 }) {
  // ANTI-SHADOWBAN: Randomize visual fingerprint per video
  const seed = clipIndex * 1337 + Date.now();
  const rng = () => {
    const x = Math.sin(seed + clipIndex * Math.random()) * 10000;
    return x - Math.floor(x);
  };

  // Vary color grading by ±0.5% (invisible to humans, unique hash per clip)
  const contrast = (1.012 + (rng() - 0.5) * 0.012).toFixed(4);   // 1.006–1.018
  const saturation = (1.006 + (rng() - 0.5) * 0.010).toFixed(4); // 1.001–1.011
  const brightness = (0.004 + (rng() - 0.5) * 0.008).toFixed(4); // 0.000–0.008

  // ANTI-SHADOWBAN: Add imperceptible noise to vary hash (instead of trim which is complex)
  const noiseStrength = (0.001 + rng() * 0.002).toFixed(4); // 0.001-0.003 (barely visible)

  // ANTI-SHADOWBAN: Vary duration by adding black frames (imperceptible delay)
  const startPadMs = Math.floor(rng() * 100); // 0-100ms black at start
  const endPadMs = Math.floor(rng() * 150);   // 0-150ms black at end
  const startPadSec = (startPadMs / 1000).toFixed(3);
  const endPadSec = (endPadMs / 1000).toFixed(3);

  const vf =
    // keep tiktok format, but use cheaper scaling (bilinear) to reduce CPU
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=bilinear," +
    "pad=1080:1920:(1080-iw)/2:(1920-ih)/2," +
    // randomized eq for unique fingerprint per clip
    `eq=contrast=${contrast}:saturation=${saturation}:brightness=${brightness},` +
    // subtle noise for additional uniqueness
    `noise=alls=${noiseStrength}:allf=t,` +
    // duration variation via black padding (start + end)
    `tpad=start_duration=${startPadSec}:stop_duration=${endPadSec}:color=black`;

  // ANTI-SHADOWBAN: Randomize encoding params
  const crf = 23 + Math.floor(rng() * 3); // 23–25
  const preset = ['superfast', 'veryfast', 'faster'][Math.floor(rng() * 3)];

  // ANTI-SHADOWBAN: Add imperceptible audio variation (prevents audio fingerprinting)
  const audioFilters = [];
  
  // Vary volume by ±1% (imperceptible but changes waveform hash)
  const volumeAdjust = (1.0 + (rng() - 0.5) * 0.02).toFixed(3); // 0.99-1.01
  audioFilters.push(`volume=${volumeAdjust}`);
  
  // Occasionally add imperceptible highpass filter (varies frequency spectrum)
  if (rng() > 0.5) {
    audioFilters.push('highpass=f=20'); // Remove <20Hz (inaudible but changes hash)
  }

  const af = audioFilters.join(',');

  console.log(
    `[FFmpeg L1] clip ${clipIndex}: contrast=${contrast}, sat=${saturation}, bright=${brightness}, noise=${noiseStrength}, crf=${crf}, preset=${preset}, duration=+${startPadMs + endPadMs}ms, audio=${af}`
  );

  // ANTI-SHADOWBAN: Randomize metadata (creation_time varies per clip)
  const randomDaysAgo = Math.floor(rng() * 30); // 0-30 days ago
  const creationTime = new Date(Date.now() - randomDaysAgo * 24 * 60 * 60 * 1000).toISOString();

  const baseArgs = [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-i",
    inputPath,
    "-vf",
    vf,
    "-af", // Audio filters (prevents audio fingerprinting)
    af,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-threads",
    "2",
    "-movflags",
    "+faststart",
    "-metadata",
    `creation_time=${creationTime}`,
    "-metadata",
    `title=`,
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

  // Audio encoding with variation (NOT copy - prevents audio fingerprinting)
  const audioArgs = ["-c:a", "aac", "-b:a", "128k", outPath];
  const finalArgs = [...baseArgs, ...audioArgs];

  return spawnFfmpeg(finalArgs);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

app.listen(PORT, () => console.log(`✅ ContentMølle backend on :${PORT}`)); 