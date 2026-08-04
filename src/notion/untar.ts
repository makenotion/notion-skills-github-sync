// Minimal POSIX tar reader.
//
// The Notion skills API hands back each skill directory as a gzipped tarball
// (`<Title>/SKILL.md` + the page's Files-property attachments), so reading tar
// is the one archive format we can't avoid. Node has no built-in untar and the
// stream-based libraries pull in a dependency tree, so this is a small pure
// reader instead — the format is fixed-width and easy to parse exactly.
//
// Supports what the server's writer (`tar-stream`) actually emits:
//   - ustar regular files, including the 155-byte `prefix` split for long paths
//   - PAX extended headers (typeflag "x"), which tar-stream uses for ANY name
//     that is non-ASCII or longer than 100 bytes — routine for Notion page
//     titles and for the API's 200-byte attachment names
//   - GNU long names (typeflag "L"), for archives from other writers
// Directories, symlinks, and global PAX headers are skipped.

const BLOCK = 512;
const decoder = new TextDecoder();

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

// Read a NUL-terminated fixed-width field.
function readString(buf: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = Math.min(offset + length, buf.length);
  while (end < limit && buf[end] !== 0) end++;
  return decoder.decode(buf.subarray(offset, end));
}

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  const raw = readString(buf, offset, length).trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

// PAX extended headers hold "<len> <key>=<value>\n" records; we only care about
// `path`, which overrides the (truncated) name in the following header.
function readPaxPath(data: Uint8Array): string | undefined {
  const text = decoder.decode(data);
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const recordLength = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(recordLength) || recordLength <= 0) break;
    const record = text.slice(space + 1, offset + recordLength).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    offset += recordLength;
  }
  return undefined;
}

/**
 * Parse a tar archive into its regular-file entries, in archive order.
 * Throws if the archive is truncated mid-entry.
 */
export function untar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  // Name supplied by a preceding PAX/GNU header, applying to the next entry.
  let pendingName: string | undefined;
  let offset = 0;

  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break; // end-of-archive marker

    const size = readOctal(header, 124, 12);
    const flagByte = header[156] ?? 0;
    // Historic writers use NUL where modern ones use "0" for a regular file.
    const typeflag = flagByte === 0 ? "0" : String.fromCharCode(flagByte);

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) {
      throw new Error("Truncated tar archive: entry data runs past end of file.");
    }
    // Entry data is padded out to a whole number of blocks.
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "x" || typeflag === "X") {
      pendingName = readPaxPath(bytes.subarray(dataStart, dataEnd)) ?? pendingName;
      continue;
    }
    if (typeflag === "L") {
      pendingName = decoder.decode(bytes.subarray(dataStart, dataEnd)).replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "g") continue; // global PAX header: not entry-specific
    if (typeflag !== "0") {
      pendingName = undefined; // directory / symlink / etc — drop any pending name
      continue;
    }

    const shortName = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const name = pendingName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    pendingName = undefined;
    if (!name) continue;

    entries.push({ name, data: bytes.slice(dataStart, dataEnd) });
  }

  return entries;
}
