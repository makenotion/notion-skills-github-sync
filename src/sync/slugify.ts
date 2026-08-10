// Turn a human plugin name into a filesystem/URL-safe slug (the directory name
// a plugin is published under).
//   "Finance "          -> "finance"
//   "html explain diff" -> "html-explain-diff"
// Skill directory names are NOT slugified here — those come from the archive,
// already unique within their plugin.
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric -> dash
    .replace(/^-+|-+$/g, "") // trim leading/trailing dashes
    .replace(/-{2,}/g, "-"); // collapse runs
  return slug;
}

// Assign a unique slug to each name, in order. Collisions get -2, -3, ... .
// Empty slugs (e.g. an all-symbol title) fall back to "skill".
export function assignUniqueSlugs<T>(
  items: T[],
  nameOf: (item: T) => string,
): Map<T, string> {
  const used = new Set<string>();
  const result = new Map<T, string>();
  for (const item of items) {
    const base = slugify(nameOf(item)) || "skill";
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    result.set(item, slug);
  }
  return result;
}
