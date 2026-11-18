/**
 * FlashBolt — combined live drill WITH the output pinned as a release
 * artifact.
 *
 * Identical to `bun run drill:all` (same runner, untouched real output,
 * streamed live while it runs) plus a verbatim copy written to
 * reports/drill-latest.txt — the artifact the release gate
 * (`bun run check:drill`, step 4/4 of `bun run verify`) requires to be
 * fresh AND fully passing (2/2).
 *
 * Exit code mirrors the drill: 0 only when every stage really passed on the
 * real networks. The artifact is written either way — an honest 0/2 with
 * the funding addresses is exactly what the gate should read.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPORT_DIR = join(import.meta.dir, "..", "reports");
const REPORT_PATH = join(REPORT_DIR, "drill-latest.txt");

async function pump(
  src: ReadableStream<Uint8Array> | undefined,
  dst: { write(chunk: Uint8Array): unknown },
  chunks: Uint8Array[],
): Promise<void> {
  if (!src) return;
  const reader = src.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      dst.write(value); // live, untouched — no rewriting, no buffering delays
    }
  }
}

async function main(): Promise<number> {
  const t0 = Date.now();
  console.log(`[drill:report] running the combined drill (artifact → reports/drill-latest.txt)…\n`);

  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "drill-all.ts")], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const pumping = Promise.all([
    pump(proc.stdout, process.stdout, outChunks),
    pump(proc.stderr, process.stderr, errChunks),
  ]);
  const code = await proc.exited;
  await pumping;

  // Verbatim artifact: real stdout then real stderr, byte-for-byte as the
  // runner produced it. No filtering, no prettifying, no verdict edits.
  const text = Buffer.concat([...outChunks, ...errChunks]).toString("utf8");
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, text, "utf8");

  const verdict = /COMBINED VERDICT:\s*(\d)\/2/.exec(text)?.[1] ?? "unknown";
  console.log(`\n[drill:report] artifact written: reports/drill-latest.txt (${text.length} bytes)`);
  console.log(`[drill:report] combined verdict inside: ${verdict}/2`);
  console.log(
    code === 0
      ? "[drill:report] gate can pass: bun run verify will accept this report while it is fresh."
      : "[drill:report] the release gate will hold (honest fail) until the drill reaches 2/2 — see DRILLS.md for funding.",
  );
  console.log(`[drill:report] took ${Date.now() - t0}ms total`);
  return code ?? 1;
}

process.exit(await main());
