# Copilot / AI Agent Instructions — europepush-content-molle

Purpose
- Help an AI or human contributor become productive quickly when changing video-batch processing, caption generation, Supabase uploads, or ffmpeg transforms.

Big picture
- Small Express service that accepts batches (1–20) of uploaded videos, applies a small visual fingerprint (ffmpeg), uploads outputs to Supabase Storage, and returns a CSV + per-clip captions. See the `/molle` handler in [index.js](index.js#L1-L120).

Important files
- [index.js](index.js#L1): server, upload limits, CORS, ffmpeg invocation, Supabase upload helpers.
- [captions.js](captions.js#L1): caption + hashtag generation via `makeBatchCaptions()`.
- [csv.js](csv.js#L1): CSV serialization `toCsv(results)` used before upload.
- [package.json](package.json#L1): `start` script and dependencies (`ffmpeg-static`, `@supabase/supabase-js`).

Runtime / env
- Start locally: `npm start` (runs `node index.js`).
- Required envs for normal operation: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (without them uploads fail). Optional: `SUPABASE_BUCKET` (defaults to `outputs`), `FRONTEND_ORIGIN`, `PORT`.

Key patterns & conventions
- Multipart uploads use `multer.memoryStorage()` and are limited to 20 files and 200MB each (change in [index.js](index.js#L1-L40)).
- Temporary working dir: `path.join(os.tmpdir(), batchId)`; files are written/read there during processing.
- FFmpeg usage: `ffmpeg-static` binary invoked with spawn. Video transforms are in `runFfmpegLevel1` in [index.js](index.js#L120-L220). Keep audio copy (`-c:a copy`) unless intentionally altering audio.
- Caption generation ensures per-batch uniqueness by shuffling arrays in [captions.js](captions.js#L1). Hashtag pools are rotated to avoid repeats.
- CSV format: header `idx,input_name,output_url,caption,hashtags` produced by [csv.js](csv.js#L1).

Integration notes
- Supabase: `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` is used server-side; uploaded objects are made public via `getPublicUrl`. The service role key must have storage permissions.
- Public URLs are returned to callers; if you change visibility/policy, update callers expecting `output_url` and `csv_url`.

Common edits you might do
- Add processing levels: implement additional `runFfmpegLevelX` functions and expand level switch in the `/molle` handler.
- Add ZIP creation: a note exists in [index.js](index.js#L180) — prefer streaming zip creation to avoid extra disk usage.
- Increase robustness: handle Supabase rate limits, retry upload logic, and ensure temp files are removed on error.

Testing & debugging tips
- To reproduce an ffmpeg error, run a local POST with `curl`/Postman sending a sample mp4 as `videos` form-data and inspect server stderr logs (ffmpeg output is captured on error).
- If uploads fail, verify `SUPABASE_*` envs and the bucket name; test with the Supabase CLI or SDK.

If unclear or incomplete
- Tell me which part you want expanded (running examples, test harness, adding ZIPs, or changing ffmpeg transforms) and I will iterate.
