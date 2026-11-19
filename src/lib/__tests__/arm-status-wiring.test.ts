/**
 * Wiring guard — every page that grades an arm must pass the ticking clock.
 *
 * The clock is a required parameter in `arm-status.ts`, so a dropped argument
 * fails `tsc` — but a page can still pass the wrong clock: `Date.now()` read
 * at render, a stamp, or a second `useNow()` that nothing keeps fresh. That
 * compiles, passes typecheck and even shows a plausible badge; it just freezes
 * until some unrelated re-render, which is how the "just now" badge survived
 * an expiring arm before. The pages are React components fed by Convex and
 * auth, so this asserts the source contract instead of mounting them: one
 * `useNow()` clock per page, and that exact identifier as the second argument
 * of every `armStatus` and `formatArmAge` call.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const PAGES = [
  { name: "Contract", path: "../../pages/terminal/Contract.tsx" },
  { name: "Overview", path: "../../pages/terminal/Overview.tsx" },
  { name: "Bot (Flasher)", path: "../../pages/terminal/Bot.tsx" },
];

/**
 * Split the argument list of `callee(...)` calls, handling nesting and strings.
 * Returns the trimmed top-level arguments of every call found.
 */
function callArgs(source: string, callee: string): string[][] {
  const out: string[][] = [];
  const needle = new RegExp(`\\b${callee}\\b`, "g");
  let match: RegExpExecArray | null;
  while ((match = needle.exec(source)) !== null) {
    let open = match.index + callee.length;
    while (/\s/.test(source[open] ?? "")) open += 1;
    // Import specifiers and prose mentions are not calls.
    if (source[open] !== "(") continue;

    const args: string[] = [];
    let current = "";
    let depth = 0;
    let quote: string | null = null;
    let i = open;

    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (quote) {
        current += ch;
        if (ch === "\\") {
          i += 1;
          current += source[i] ?? "";
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth += 1;
        if (depth === 1) continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0) {
          if (current.trim()) args.push(current.trim());
          break;
        }
      }
      if (ch === "," && depth === 1) {
        args.push(current.trim());
        current = "";
        continue;
      }
      if (depth >= 1) current += ch;
    }

    if (depth !== 0) throw new Error(`unbalanced ${callee}( in source`);
    out.push(args);
    needle.lastIndex = i;
  }
  return out;
}

/** The clock identifier a page declares from the shared hook, e.g. `now`. */
function clockVariable(name: string, source: string): string {
  const imported = /import\s*\{[^}]*\buseNow\b[^}]*\}\s*from\s*["']@\/hooks\/use-now["']/.test(
    source,
  );
  if (!imported) {
    throw new Error(
      `${name} does not import useNow from "@/hooks/use-now" — its arm status would freeze at render time`,
    );
  }
  const declared = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*useNow\s*\(/.exec(source);
  if (!declared) {
    throw new Error(`${name} imported useNow but never calls it`);
  }
  return declared[1];
}

/**
 * Throws unless every clock-consuming call on the page receives the page's
 * clock. `armStatus` must exist (the badge is the whole point); `formatArmAge`
 * is checked wherever a page shows an age, because a frozen "3h 0m ago" next to
 * a live badge is the same regression half-fixed.
 */
function assertClockCalls(
  name: string,
  source: string,
  callee: "armStatus" | "formatArmAge",
  clock: string,
  required: boolean,
): void {
  const calls = callArgs(source, callee);
  if (required && calls.length === 0) {
    throw new Error(`${name} calls ${callee} nowhere — the guard tested nothing`);
  }
  for (const args of calls) {
    if (args.length !== 2) {
      throw new Error(
        `${name}: ${callee}(${args.join(", ")}) does not pass the ticking clock as its second argument (expected \`${clock}\`)`,
      );
    }
    if (args[1] !== clock) {
      throw new Error(
        `${name}: ${callee}'s second argument is \`${args[1]}\`, not the ticking clock \`${clock}\``,
      );
    }
    if (args[0].includes("Date.now")) {
      throw new Error(`${name}: ${callee} reads Date.now() inline instead of the shared clock`);
    }
  }
}

/** Throws unless every armStatus (and any displayed age) uses the page clock. */
function assertWired(name: string, source: string): void {
  const clock = clockVariable(name, source);
  assertClockCalls(name, source, "armStatus", clock, true);
  assertClockCalls(name, source, "formatArmAge", clock, false);
}

describe("arm status wiring — the clock reaches every page", () => {
  for (const page of PAGES) {
    test(`${page.name} passes its useNow clock into armStatus`, () => {
      const source = readFileSync(new URL(page.path, import.meta.url), "utf8");
      expect(() => assertWired(page.name, source)).not.toThrow();
    });
  }

  test("Contract passes the same clock into every displayed arm age", () => {
    const source = readFileSync(
      new URL("../../pages/terminal/Contract.tsx", import.meta.url),
      "utf8",
    );
    // current arm, first armed, last saved — three labels under the badge.
    expect(callArgs(source, "formatArmAge")).toHaveLength(3);
  });

  test("the guard fails when an age label drops the clock", () => {
    const broken = `
      import { useNow } from "@/hooks/use-now";
      const now = useNow();
      const arm = armStatus(deployment?.armedAt, now);
      const age = formatArmAge(deployment?.armedAt);
    `;
    expect(() => assertWired("Broken", broken)).toThrow(/formatArmAge.*second argument/);
  });

  test("the guard fails when the second argument is dropped", () => {
    const broken = `
      import { useNow } from "@/hooks/use-now";
      const now = useNow();
      const arm = armStatus(deployment?.armedAt);
    `;
    expect(() => assertWired("Broken", broken)).toThrow(/second argument/);
  });

  test("the guard fails when a page passes Date.now() instead of the shared clock", () => {
    const broken = `
      import { useNow } from "@/hooks/use-now";
      const now = useNow();
      const arm = armStatus(deployment?.armedAt, Date.now());
    `;
    expect(() => assertWired("Broken", broken)).toThrow(/Date\.now|second argument/);
  });

  test("the guard fails when a page never imports the ticking hook", () => {
    const broken = `
      const arm = armStatus(deployment?.armedAt, Date.now());
    `;
    expect(() => assertWired("Broken", broken)).toThrow(/does not import useNow/);
  });
});
