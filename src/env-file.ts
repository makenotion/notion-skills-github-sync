/**
 * Merge new `KEY=value` lines into an existing `.env`, leaving any key the file
 * already sets alone. Pure: takes and returns file contents.
 *
 * Never overwriting is the point — the file is the user's, and a half-migrated
 * deployment where the file says one thing and the tool another is worse than
 * no write at all.
 */
export function mergeEnvFile(
  existing: string,
  lines: string[],
): { content: string; written: string[]; skipped: string[] } {
  const present = new Set(
    existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("=")[0]?.trim())
      .filter((k): k is string => Boolean(k)),
  );

  const written: string[] = [];
  const skipped: string[] = [];
  const additions: string[] = [];
  for (const line of lines) {
    if (line.startsWith("#") || !line.includes("=")) {
      additions.push(line);
      continue;
    }
    const key = line.split("=")[0]!.trim();
    if (present.has(key)) {
      skipped.push(key);
      continue;
    }
    written.push(key);
    additions.push(line);
  }

  // Drop trailing comment-only blocks that ended up with nothing under them.
  while (additions.length && !additions[additions.length - 1]!.includes("=")) additions.pop();
  if (additions.length === 0) return { content: existing, written, skipped };

  const prefix = existing.trim() ? `${existing.replace(/\n+$/, "")}\n\n` : "";
  return { content: `${prefix}${additions.join("\n")}\n`, written, skipped };
}
