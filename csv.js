function escapeCsv(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

export function toCsv(results) {
  const header = ["video", "caption", "hashtags"].join(",");
  const rows = results.map(r => {
    const hashtags = (r.hashtags || []).join(" ");
    return [
      escapeCsv(r.output_url),
      escapeCsv(r.caption),
      escapeCsv(hashtags)
    ].join(",");
  });
  return [header, ...rows].join("\n");
}