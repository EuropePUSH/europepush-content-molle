function escapeCsv(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

// Metricool CSV format:
// Column A: Text
// Column B: Images/Videos (URL)
export function toCsv(results) {
  const header = ["text", "media"].join(",");

  const rows = results.map(r => {
    const hashtags = (r.hashtags || []).join(" ");
    const text = [r.caption, hashtags].filter(Boolean).join("\n\n");

    return [
      escapeCsv(text),
      escapeCsv(r.output_url)
    ].join(",");
  });

  return [header, ...rows].join("\n");
}