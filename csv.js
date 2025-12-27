function escapeCsv(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

export function toCsv(results) {
  const header = ["idx", "input_name", "output_url", "caption", "hashtags"].join(",");
  const rows = results.map(r => {
    const hashtags = (r.hashtags || []).join(" ");
    return [
      r.idx,
      escapeCsv(r.input_name),
      escapeCsv(r.output_url),
      escapeCsv(r.caption),
      escapeCsv(hashtags)
    ].join(",");
  });
  return [header, ...rows].join("\n");
}