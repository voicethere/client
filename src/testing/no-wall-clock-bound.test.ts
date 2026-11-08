// Guard (test.wall-clock-budget): a test must not assert an ordering bound on a wall-clock or CPU-time
// measurement. Such bounds pass on an idle laptop and fail on a loaded CI runner. Make the assertion causal
// (fake timers + advanceTimersByTime, or assert the outcome) instead.
// Keep this scanner and its fixtures equivalent to the copy in the agent repo.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const MATCHERS = new Set([
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeCloseTo",
]);

function callPath(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return `${callPath(expr.expression)}.${expr.name.text}`;
  return "";
}

function isTimingCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const p = callPath(node.expression);
  return (
    p === "Date.now" ||
    p === "performance.now" ||
    p === "process.hrtime" ||
    p === "process.hrtime.bigint" ||
    p === "process.cpuUsage"
  );
}

function containsTiming(node: ts.Node, tainted: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (isTimingCall(n) || (ts.isIdentifier(n) && tainted.has(n.text))) {
      found = true;
      return;
    }
    // `payload.ts`: only the object side is checked, never the property name.
    if (ts.isPropertyAccessExpression(n)) {
      visit(n.expression);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** `expect`, `expect.soft` or `expect.poll`. */
function isExpectCallee(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return e.text === "expect";
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "expect" &&
    (e.name.text === "soft" || e.name.text === "poll")
  );
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) bindingNames(el.name, out);
  }
}

/** 1-based lines of `expect(<timing-derived>).<ordering matcher>(...)` calls. */
export function findWallClockBounds(source: string, fileName: string): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const tainted = new Set<string>();

  // Taint fixpoint, keyed by identifier name (simple on purpose).
  for (let changed = true; changed; ) {
    changed = false;
    const mark = (names: string[]): void => {
      for (const n of names) {
        if (!tainted.has(n)) {
          tainted.add(n);
          changed = true;
        }
      }
    };
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer && containsTiming(n.initializer, tainted)) {
        const names: string[] = [];
        bindingNames(n.name, names);
        mark(names);
      } else if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        containsTiming(n.right, tainted)
      ) {
        mark([n.left.text]);
      } else if (ts.isFunctionDeclaration(n) && n.name && n.body && containsTiming(n.body, tainted)) {
        mark([n.name.text]);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      MATCHERS.has(n.expression.name.text)
    ) {
      let target: ts.Expression = n.expression.expression;
      // Walk through `.not` / `.resolves` / `.rejects` to the expect(...) call.
      while (ts.isPropertyAccessExpression(target)) target = target.expression;
      if (
        ts.isCallExpression(target) &&
        isExpectCallee(target.expression) &&
        target.arguments.length > 0 &&
        containsTiming(target.arguments[0]!, tainted)
      ) {
        lines.push(sf.getLineAndCharacterOfPosition(target.getStart(sf)).line + 1);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...new Set(lines)].sort((a, b) => a - b);
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures", "wall-clock");
const SRC_ROOT = join(here, "..");
const PKG_ROOT = join(here, "..", "..");
const SELF = join(here, "no-wall-clock-bound.test.ts");

describe("findWallClockBounds", () => {
  it("flags the pre-agent#176 redact shape at the expect(large / small) line", () => {
    const src = readFileSync(join(FIXTURES, "pre-agent-176-redact.ts.txt"), "utf8");
    const line = src.split("\n").findIndex((l) => l.includes("expect(large / small)")) + 1;
    expect(line).toBeGreaterThan(0);
    expect(findWallClockBounds(src, "f.ts")).toEqual([line]);
  });

  it.each([
    ["Date.now delta inline", "expect(Date.now() - t0).toBeLessThan(100);"],
    [
      "performance.now delta via variable",
      "const e = performance.now() - t;\nexpect(e).toBeGreaterThan(5);",
    ],
    [
      "process.hrtime destructured",
      "const [s] = process.hrtime(start);\nexpect(s).toBeLessThan(1);",
    ],
    ["process.hrtime.bigint", "expect(process.hrtime.bigint() - t).toBeLessThan(10n);"],
    ["plain assignment", "let t;\nt = performance.now();\nexpect(t).toBeGreaterThan(0);"],
    ["expect.soft", "expect.soft(Date.now() - t0).toBeLessThan(100);"],
    ["expect.poll", "expect.poll(() => Date.now() - t0).toBeLessThan(100);"],
  ])("flags %s", (_n, code) => {
    const line = code.split("\n").length;
    expect(findWallClockBounds(code, "f.ts")).toEqual([line]);
  });

  it.each([
    ["length bound", "expect(calls.length).toBeLessThan(3);"],
    ["Date.now equality", "expect(Date.now()).toBe(1000);"],
    ["timestamp equality", "const ts = Date.now();\nexpect(payload.ts).toBe(ts);"],
    ["property named like a tainted variable", "const ts = Date.now();\nexpect(payload.ts).toBeLessThan(5);"],
    ["plain arithmetic", "expect(a - b).toBeLessThan(2);"],
  ])("does not flag %s", (_n, code) => {
    expect(findWallClockBounds(code, "f.ts")).toEqual([]);
  });
});

export type AllowEntry = { file: string; expect: string; reason: string };
export type Hit = { file: string; line: number; text: string };

/** Violations are hits with no entry; an entry is keyed by file and the trimmed line text, so it never hides a whole file. */
export function applyAllowlist(
  hits: Hit[],
  allowlist: AllowEntry[],
): { violations: string[]; stale: string[] } {
  const key = (file: string, text: string): string => `${file}|${text.trim()}`;
  const allowed = new Set(allowlist.map((a) => key(a.file, a.expect)));
  const hitKeys = new Set(hits.map((h) => key(h.file, h.text)));
  return {
    violations: hits
      .filter((h) => !allowed.has(key(h.file, h.text)))
      .map((h) => `${h.file}:${h.line}: ${h.text.trim()}`),
    stale: allowlist.filter((a) => !hitKeys.has(key(a.file, a.expect))).map((a) => `${a.file}|${a.expect.trim()}`),
  };
}

// Each entry needs a concrete, non-empty reason; a stale entry (no longer a hit) fails.
const ALLOWLIST: AllowEntry[] = [];

function listTests(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "browser-stereo" || e.name === "fixtures") continue;
      listTests(p, out);
    } else if (e.name.endsWith(".test.ts") && p !== SELF) {
      out.push(p);
    }
  }
}

describe("applyAllowlist", () => {
  const A = "expect(x - Date.now()).toBeLessThan(5);";
  const entry = { file: "a.test.ts", expect: A, reason: "fake clock" };
  it("a second bound in an allowlisted file is still a violation", () => {
    const r = applyAllowlist(
      [
        { file: "a.test.ts", line: 3, text: `  ${A}` },
        { file: "a.test.ts", line: 9, text: "expect(Date.now() - t0).toBeLessThan(5);" },
      ],
      [entry],
    );
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toContain("a.test.ts:9");
    expect(r.stale).toEqual([]);
  });
  it("an entry with no hit is stale", () => {
    const r = applyAllowlist([], [entry]);
    expect(r.violations).toEqual([]);
    expect(r.stale).toHaveLength(1);
  });
});

describe("repo scan", () => {
  const files: string[] = [];
  listTests(SRC_ROOT, files);
  listTests(join(PKG_ROOT, "test"), files);
  const hits: Hit[] = [];
  for (const f of files) {
    const source = readFileSync(f, "utf8");
    const srcLines = source.split("\n");
    for (const line of findWallClockBounds(source, f)) {
      hits.push({ file: relative(PKG_ROOT, f), line, text: srcLines[line - 1] ?? "" });
    }
  }
  const result = applyAllowlist(hits, ALLOWLIST);

  it("has no wall-clock or CPU-time ordering bounds outside the allowlist", () => {
    expect(result.violations).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    expect(result.stale).toEqual([]);
  });

  it("gives every allowlist entry a reason", () => {
    expect(ALLOWLIST.filter((a) => a.reason.trim() === "").map((a) => a.file)).toEqual([]);
  });
});
