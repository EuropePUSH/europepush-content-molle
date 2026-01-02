function escapeCsv(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

/**
 * Metricool AUTOLIST CSV
 * EXACTLY TWO COLUMNS:
 *  1. Text
 *  2. Picture Url 1 (direct public mp4 link)
 */
export function toCsv(results = []) {
  const header = ["Text", "Picture Url 1"].join(",");

  const rows = results
    .filter(r => r && (r.output_url || r.videoUrl || r.video_url))
    .map((r) => {
      const caption = (r.caption || "").trim();

      const hashtags = Array.isArray(r.hashtags)
        ? r.hashtags
            .map(h => String(h).trim())
            .filter(Boolean)
            .join(" ")
        : "";

      // Metricool expects ONE text field
      const text =
        caption && hashtags
          ? `${caption}\n\n${hashtags}`
          : caption || hashtags || "";

      const videoUrl =
        r.output_url || r.videoUrl || r.video_url || "";

      return [
        escapeCsv(text),
        escapeCsv(videoUrl)
      ].join(",");
    });

  return [header, ...rows].join("\n");
}