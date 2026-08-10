// A minimal tar *writer*, used only by tests to exercise src/untar.ts against
// real wire-format bytes (including the PAX long-name path the Notion skills
// API's writer, `tar-stream`, uses for non-ASCII or >100-byte names).

const BLOCK = 512;
const encoder = new TextEncoder();

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`Field overflow at ${offset}: ${value}`);
  block.set(bytes, offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeString(block, offset, length, value.toString(8).padStart(length - 1, "0"));
}

function header(opts: { name: string; size: number; typeflag: string; prefix?: string }): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeString(block, 0, 100, opts.name);
  writeString(block, 100, 8, "0000644");
  writeString(block, 108, 8, "0000000");
  writeString(block, 116, 8, "0000000");
  writeOctal(block, 124, 12, opts.size);
  writeOctal(block, 136, 12, 0);
  writeString(block, 148, 8, "        "); // checksum placeholder: 8 spaces
  writeString(block, 156, 1, opts.typeflag);
  writeString(block, 257, 6, "ustar");
  writeString(block, 263, 2, "00");
  if (opts.prefix) writeString(block, 345, 155, opts.prefix);

  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function pad(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  padded.set(data);
  return padded;
}

export interface TarInput {
  /** ustar `name` field (≤100 bytes). */
  name: string;
  data: Uint8Array | string;
  /** ustar `prefix` field, joined to `name` with "/". */
  prefix?: string;
  /** Real path, emitted as a preceding PAX header — overrides name/prefix. */
  paxPath?: string;
  /** Defaults to "0" (regular file). */
  typeflag?: string;
}

/** Build a tar archive, PAX headers and all. */
export function makeTar(entries: TarInput[]): Uint8Array {
  const chunks: Uint8Array[] = [];

  for (const entry of entries) {
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;

    if (entry.paxPath) {
      // "<len> path=<value>\n", where <len> counts itself.
      const suffix = ` path=${entry.paxPath}\n`;
      let length = suffix.length;
      // The length prefix changes the length; settle on a fixed point.
      for (let i = 0; i < 3; i++) length = suffix.length + String(length).length;
      const record = encoder.encode(`${length}${suffix}`);
      chunks.push(header({ name: "PaxHeader", size: record.length, typeflag: "x" }));
      chunks.push(pad(record));
    }

    chunks.push(
      header({
        name: entry.name,
        prefix: entry.prefix,
        size: data.length,
        typeflag: entry.typeflag ?? "0",
      }),
    );
    if (data.length > 0) chunks.push(pad(data));
  }

  chunks.push(new Uint8Array(BLOCK * 2)); // end-of-archive marker

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
