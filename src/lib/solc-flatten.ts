/**
 * Real Solidity source flattener.
 *
 * Takes the import closure the compiler worker already fetched and produces a
 * single-file source by inlining every `import` at its call site — the exact
 * format BscScan's "verify & publish" wizard accepts. Pure string
 * transformation: no compilation, no simulation, just real source.
 */

/** Matches `import "x.sol"` and `import {A} from "x.sol"`. */
export const IMPORT_RE = /(?:import\s*\{[^}]*\}\s*from\s*|import\s+)(["'])([^"']+)\1/g;

/** Resolve relative ./ and ../ imports against the importer's path. */
export function resolveImport(importer: string, imp: string): string {
  if (!imp.startsWith(".")) return imp;
  let dir = importer.includes("/")
    ? importer.slice(0, importer.lastIndexOf("/") + 1)
    : "";
  let rel = imp;
  while (rel.startsWith("../")) {
    dir = dir.replace(/[^/]+\/$/, "");
    rel = rel.slice(3);
  }
  if (rel.startsWith("./")) rel = rel.slice(2);
  return dir + rel;
}

/** Strip SPDX + pragma headers from dependency files (the root keeps its own). */
export function stripImportHeaders(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) =>
        !/^\s*\/\/\s*SPDX-License-Identifier:/.test(line) &&
        !/^\s*pragma solidity/.test(line),
    )
    .join("\n");
}

/**
 * Flatten an import closure into a single file. Each import statement is
 * replaced with the fully flattened content of the imported file (headers
 * stripped for every non-root file, so the result carries one pragma and one
 * SPDX line). Cycles are guarded — a repeated file is inlined only once.
 */
export function flattenSoliditySource(
  rootName: string,
  files: Map<string, string>,
): string {
  const memo = new Map<string, string>();
  const visiting = new Set<string>();

  const flatten = (name: string, isRoot: boolean): string => {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    if (visiting.has(name)) return ""; // import cycle guard
    visiting.add(name);
    const raw = files.get(name) ?? "";
    const text = isRoot ? raw : stripImportHeaders(raw);
    const re = new RegExp(IMPORT_RE.source, "g");
    let last = 0;
    let result = "";
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      result += text.slice(last, m.index);
      const target = resolveImport(name, m[2]);
      result += flatten(target, false);
      last = re.lastIndex;
    }
    result += text.slice(last);
    visiting.delete(name);
    memo.set(name, result);
    return result;
  };

  return flatten(rootName, true);
}
