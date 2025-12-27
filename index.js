import express from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { nanoid } from "nanoid";
import { createClient } from "@supabase/supabase-js";

import { makeBatchCaptions } from "./captions.js";
import { toCsv } from "./csv.js";

const app = express();

const PORT = process.env.PORT || 10000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://europepush.com";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "outputs";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("[WARN] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

// ---- very small CORS (Base44 -> backend)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === FRONTEND_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health
app.get("/", (req, res) => res.json({ ok: true, service: "content-molle" }));

// Upload handler
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 20,
    fileSize: 200 * 1024 * 1024 // 200MB per file (just in case)
  }
});

// ---- Main endpoint: batch mode (1–20)
app.post("/molle", upload.array("videos", 20), async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase_not_configured" });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: "no_videos_uploaded" });

    // Settings from form-data
    const noCaptionMode = (req.body.noCaptionMode === "true");
    const level = (req.body.level || "1"); // only 1 supported right now
    const theme = (req.body.theme || "snus").trim();
    const maxCount = Math.min(files.length, 20);

    const batchId = `batch_${nanoid(10)}`;
    const tmpDir = path.join(os.tmpdir(), batchId);
    await fs.mkdir(tmpDir, { recursive: true });

    const captionsPack = makeBatchCaptions({ count: maxCount, noCaptionMode, theme });

    const results = [];

    for (let i = 0; i < maxCount; i++) {
      const f = files[i];
      const inputPath = path.join(tmpDir, `in_${i}.mp4`);
      const outPath = path.join(tmpDir, `out_${i}.mp4`);

      await fs.writeFile(inputPath, f.buffer);

      // Level-1: tiny visual fingerprint changes, audio copied
      await runFfmpegLevel1({ inputPath, outPath });

      const outBuf = await fs.readFile(outPath);

      // Upload mp4 to Supabase Storage
      const objectPath = `batches/${batchId}/clip_${String(i + 1).padStart(2, "0")}.mp4`;
      const publicUrl = await uploadToSupabase(objectPath, outBuf, "video/mp4");

      const cap = captionsPack.items[i]; // { caption, hashtags[] }
      results.push({
        idx: i,
        input_name: f.originalname,
        output_url: publicUrl,
        caption: cap.caption,
        hashtags: cap.hashtags
      });
    }

    // CSV + ZIP uploads
    const csv = toCsv(results);
    const csvPath = `batches/${batchId}/captions.csv`;
    const csvUrl = await uploadToSupabase(csvPath, Buffer.from(csv, "utf8"), "text/csv");

    // Optional: Zip (simple implementation: store CSV only or skip)
    // For speed/stability, we skip zip creation by default. You can add it later.
    // If you want ZIP now, say til — så giver jeg zip streaming + upload.

    return res.json({
      ok: true,
      batchId,
      level,
      noCaptionMode,
      theme,
      count: results.length,
      csv_url: csvUrl,
      zip_url: null,
      results
    });
  } catch (err) {
    console.error("[/molle] error:", err);
    res.status(500).json({ ok: false, error: "internal_error", message: err.message });
  }
});

async function uploadToSupabase(objectPath, buffer, contentType) {
  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(objectPath, buffer, { contentType, upsert: true });

  if (error) throw error;

  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
}

function runFfmpegLevel1({ inputPath, outPath }) {
  return new Promise((resolve, reject) => {
    const vf =
      // keep tiktok format, then tiny changes:
      "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=lanczos," +
      "pad=1080:1920:(1080-iw)/2:(1920-ih)/2," +
      // micro crop -> pad back (fingerprint change)
      "crop=1078:1918:1:1,pad=1080:1920:1:1," +
      // micro noise + tiny eq
      "noise=alls=6:allf=t,eq=contrast=1.02:saturation=1.01:brightness=0.01";

    const args = [
      "-y",
      "-hide_banner",
      "-nostdin",
      "-i", inputPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-preset", "medium",
      "-crf", "19",
      // keep audio identical if possible
      "-c:a", "copy",
      "-movflags", "+faststart",
      outPath
    ];

    const ff = spawn(ffmpegPath, args);

    let stderr = "";
    ff.stderr.on("data", (d) => { stderr += d.toString(); });

    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg_failed code=${code}\n${stderr.slice(-3000)}`));
    });
  });
}

app.listen(PORT, () => console.log(`✅ ContentMølle backend on :${PORT}`));