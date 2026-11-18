/**
 * Minimal store-only ZIP writer — zero dependencies, works in the browser
 * (extension one-click downloads) and under Bun (CLI `bun run overlay`).
 *
 * Produces spec-compliant ZIP archives (local file headers + central
 * directory + EOCD) with no compression (method 0), which every OS and
 * browser unzip handler reads natively. Text is UTF-8 encoded with the
 * UTF-8 flag set.
 */

// ── CRC-32 (IEEE, reflected, poly 0xEDB88320) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  content: string;
}

/** Build a complete ZIP archive from text entries. Returns the raw bytes. */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) =>
    new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
  const cat = (...arrays: Uint8Array[]) => {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const a of arrays) {
      out.set(a, pos);
      pos += a.length;
    }
    return out;
  };

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);

    // Local file header
    const local = cat(
      u32(0x04034b50),
      u16(20), // version needed
      u16(0x0800), // flags: UTF-8
      u16(0), // method: store
      u16(0), // mod time
      u16(0x21), // mod date (1980-01-01, deterministic)
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0), // extra len
      nameBytes,
      data,
    );
    chunks.push(local);

    // Central directory record
    central.push(
      cat(
        u32(0x02014b50),
        u16(20), // version made by
        u16(20), // version needed
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0x21),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ),
    );

    offset += local.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const eocd = cat(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralSize),
    u32(centralStart),
    u16(0),
  );

  return cat(...chunks, ...central, eocd);
}
