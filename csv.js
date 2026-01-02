function escapeCsv(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

/**
 * Generates a Metricool CALENDAR-compatible CSV.
 * One row = one TikTok post.
 * Scheduling (4/day etc.) is handled inside Metricool, not here.
 */
export function toCsv(results = []) {
  const header = [
    "Text",
    "Date",
    "Time",
    "Draft",
    "Facebook",
    "Twitter",
    "LinkedIn",
    "GBP",
    "Instagram",
    "Pinterest",
    "TikTok",
    "YouTube",
    "Threads",
    "Picture Url 1",
    "TikTok Post Privacy"
  ].join(",");

  const rows = results.map((r) => {
    const caption = r.caption || "";
    const hashtags = Array.isArray(r.hashtags) ? r.hashtags.join(" ") : "";
    const text = [caption, hashtags].filter(Boolean).join("\n\n");

    const videoUrl = r.output_url || r.videoUrl || "";

    return [
      escapeCsv(text),
      "",                 // Date (empty = Metricool decides)
      "",                 // Time
      "FALSE",            // Draft
      "FALSE",            // Facebook
      "FALSE",            // Twitter
      "FALSE",            // LinkedIn
      "FALSE",            // GBP
      "FALSE",            // Instagram
      "FALSE",            // Pinterest
      "TRUE",             // TikTok
      "FALSE",            // YouTube
      "FALSE",            // Threads
      escapeCsv(videoUrl),
      "PUBLIC_TO_EVERYONE"
    ].join(",");
  });

  return [header, ...rows].join("\n");
}