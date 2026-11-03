import { describe, expect, it, vi } from "vitest";
import { createDebugConsole, DEBUG_CONSOLE_MAX_EVENTS } from "./debug-console";

const MAX = DEBUG_CONSOLE_MAX_EVENTS;

function fill(c: ReturnType<typeof createDebugConsole>, n: number) {
  for (let i = 0; i < n; i++) c.info("test", `e${i}`);
}

describe("createDebugConsole ring buffer", () => {
  it("keeps every event below the cap in order", () => {
    const c = createDebugConsole();
    fill(c, 3);
    expect(c.events().map((e) => e.name)).toEqual(["e0", "e1", "e2"]);
  });

  it("N+1 events keep the newest N", () => {
    const c = createDebugConsole();
    fill(c, MAX + 1);
    const names = c.events().map((e) => e.name);
    expect(names).toHaveLength(MAX);
    expect(names[0]).toBe("e1");
    expect(names[MAX - 1]).toBe(`e${MAX}`);
  });

  it("wraps around more than once in order", () => {
    const c = createDebugConsole();
    fill(c, 1234);
    const expected = Array.from(
      { length: MAX },
      (_, i) => `e${1234 - MAX + i}`,
    );
    expect(expected[0]).toBe("e734");
    expect(c.events().map((e) => e.name)).toEqual(expected);
  });

  it("the sink sees every event", () => {
    const onEvent = vi.fn();
    const c = createDebugConsole(onEvent);
    fill(c, MAX + 1);
    expect(onEvent).toHaveBeenCalledTimes(MAX + 1);
    expect(onEvent.mock.calls[MAX][0].name).toBe(`e${MAX}`);
  });

  it("exportText holds the newest N lines", () => {
    const c = createDebugConsole();
    fill(c, MAX + 1);
    const lines = c.exportText().split("\n");
    expect(lines).toHaveLength(MAX);
    expect(lines[0]).toMatch(/\/e1$/);
  });

  it("clear empties the ring and pushes start fresh", () => {
    const c = createDebugConsole();
    fill(c, MAX + 5);
    c.clear();
    expect(c.events()).toEqual([]);
    c.info("test", "x");
    expect(c.events().map((e) => e.name)).toEqual(["x"]);
  });

  it("events() returns a copy", () => {
    const c = createDebugConsole();
    fill(c, 2);
    const first = c.events();
    first.length = 0;
    expect(c.events()).toHaveLength(2);
  });
});
