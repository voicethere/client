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
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
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
        ts.isIdentifier(target.expression) &&
        target.expression.text === "expect" &&
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
  ])("flags %s", (_n, code) => {
    const line = code.split("\n").length;
    expect(findWallClockBounds(code, "f.ts")).toEqual([line]);
  });

  it.each([
    ["length bound", "expect(calls.length).toBeLessThan(3);"],
    ["Date.now equality", "expect(Date.now()).toBe(1000);"],
    ["timestamp equality", "const ts = Date.now();\nexpect(payload.ts).toBe(ts);"],
    ["plain arithmetic", "expect(a - b).toBeLessThan(2);"],
  ])("does not flag %s", (_n, code) => {
    expect(findWallClockBounds(code, "f.ts")).toEqual([]);
  });
});

// Each entry needs a concrete reason; a stale entry (file gone or no longer a hit) fails.
const ALLOWLIST: Array<{ file: string; reason: string }> = [
  {
    file: "src/browser/browser-voice-session-recovery.test.ts",
    reason:
      "Remaining hits assert recovery.downtimeMs inside tests that run under vi.useFakeTimers(); the library's Date.now() is the fake clock, advanced only by advanceTimersByTimeAsync, so the bound is causal. (Flagged because the connectReady helper contains Date.now().)",
  },
];

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

describe("repo scan", () => {
  const files: string[] = [];
  listTests(SRC_ROOT, files);
  listTests(join(PKG_ROOT, "test"), files);
  const hits = new Map<string, number[]>();
  for (const f of files) {
    const lines = findWallClockBounds(readFileSync(f, "utf8"), f);
    if (lines.length > 0) hits.set(relative(PKG_ROOT, f), lines);
  }
  const allowed = new Set(ALLOWLIST.map((a) => a.file));

  it("has no wall-clock or CPU-time ordering bounds outside the allowlist", () => {
    const violations = [...hits].filter(([f]) => !allowed.has(f)).map(([f, l]) => `${f}:${l.join(",")}`);
    expect(violations).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const stale = ALLOWLIST.filter((a) => !hits.has(a.file)).map((a) => a.file);
    expect(stale).toEqual([]);
  });
});
