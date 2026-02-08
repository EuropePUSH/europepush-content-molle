function escapeCsv(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

// ANTI-SHADOWBAN: Shuffle array (so different accounts get different video order)
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Metricool AUTOLIST CSV
 * EXACTLY TWO COLUMNS:
 *  1. Text
 *  2. Picture Url 1 (direct public mp4 link)
 * 
 * @param {Array} results - Array of video results
 * @param {Object} options - Options for CSV generation
 * @param {boolean} options.shuffleOrder - If true, randomize row order (anti-shadowban)
 */
export function toCsv(results = [], options = {}) {
  const { shuffleOrder = false } = options;
  
  const header = ["Text", "Picture Url 1"].join(",");

  let validResults = results.filter(r => r && (r.output_url || r.videoUrl || r.video_url));
  
  // ANTI-SHADOWBAN: Shuffle results so each account gets different posting order
  if (shuffleOrder) {
    validResults = shuffle(validResults);
  }

  const rows = validResults.map((r) => {
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