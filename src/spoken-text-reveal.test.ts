import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAgentTextReveal,
  type AgentTextUpdate,
  type SpokenTextRevealMode,
} from "./spoken-text-reveal.js";

const delta = (turnId: string, text: string, extra = {}) => ({
  type: "assistant_delta",
  turnId,
  text,
  spoken: true,
  ...extra,
});
const done = (
  turnId: string,
  text: string,
  status = "completed",
  extra = {},
) => ({
  type: "assistant_done",
  turnId,
  text,
  status,
  spoken: true,
  ...extra,
});
const speech = (event: string) => ({ type: "speech_event", event });

function setup(mode?: SpokenTextRevealMode) {
  const updates: AgentTextUpdate[] = [];
  const reveal = createAgentTextReveal({
    mode,
    onAgentText: (u) => updates.push(u),
  });
  const lastText = (turnId: string) =>
    [...updates].reverse().find((u) => u.turnId === turnId)?.text;
  return { reveal, updates, lastText };
}

describe("createAgentTextReveal (spoken turns, playback)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delta pacing waits for agent_speaking_start, then grows word by word to the full text", () => {
    const { reveal, updates, lastText } = setup();
    reveal.handleControlMessage(delta("A", "One two three."));
    expect(updates).toEqual([]);
    reveal.handleControlMessage(speech("agent_speaking_start"));
    expect(updates.map((u) => u.text)).toEqual(["One"]);
    vi.advanceTimersByTime(330);
    expect(lastText("A")).toBe("One two");
    reveal.handleControlMessage(done("A", "One two three."));
    vi.advanceTimersByTime(330 * 5);
    expect(lastText("A")).toBe("One two three.");
    let previous = 0;
    for (const u of updates) {
      const n = u.text.split(/\s+/).length;
      expect(n - previous).toBeLessThanOrEqual(1);
      previous = n;
      expect(u.spoken).toBe(true);
    }
    const finals = updates.filter((u) => u.final);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe("One two three.");
    vi.advanceTimersByTime(10_000);
    expect(updates.at(-1)!.final).toBe(true);
  });

  it("pauses between speech chunks and continues at the next start", () => {
    const { reveal, lastText } = setup();
    reveal.handleControlMessage(delta("A", "One two."));
    reveal.handleControlMessage(speech("agent_speaking_start"));
    vi.advanceTimersByTime(330);
    reveal.handleControlMessage(speech("agent_speaking_end"));
    const shown = lastText("A");
    expect(shown).toBe("One two.");
    reveal.handleControlMessage(delta("A", "Three four five."));
    vi.advanceTimersByTime(5_000);
    expect(lastText("A")).toBe(shown);
    reveal.handleControlMessage(speech("agent_speaking_start"));
    vi.advanceTimersByTime(330 * 10);
    expect(lastText("A")).toBe("One two. Three four five.");
  });

  it("assistant_done snaps nothing ahead of the audio: only the shown words are visible", () => {
    const { reveal, lastText } = setup();
    reveal.handleControlMessage(delta("A", "One two three four five six."));
    reveal.handleControlMessage(speech("agent_speaking_start"));
    vi.advanceTimersByTime(330);
    reveal.handleControlMessage(done("A", "One two three four five six."));
    expect(lastText("A")!.split(/\s+/).length).toBeLessThan(6);
    vi.advanceTimersByTime(330 * 10);
    expect(lastText("A")).toBe("One two three four five six.");
  });

  it("barge_in freezes the line at what was visible", () => {
    const { reveal, updates, lastText } = setup();
    reveal.handleControlMessage(delta("D", "One two three four five six."));
    reveal.handleControlMessage(speech("agent_speaking_start"));
    vi.advanceTimersByTime(330);
    reveal.handleControlMessage(speech("barge_in"));
    const frozen = lastText("D");
    reveal.handleControlMessage(delta("D", "Seven eight."));
    vi.advanceTimersByTime(5_000);
    expect(lastText("D")).toBe(frozen);
    reveal.handleControlMessage(
      done("D", "One two three four five six.", "interrupted"),
    );
    expect(lastText("D")).toBe(frozen);
    expect(updates.at(-1)!.final).toBe(true);
  });

  it.each(["interrupted", "cancelled", "failed"])(
    "status %s freezes at the spoken prefix",
    (status) => {
      const { reveal, updates, lastText } = setup();
      reveal.handleControlMessage(delta("C", "One two three four five six."));
      reveal.handleControlMessage(speech("agent_speaking_start"));
      vi.advanceTimersByTime(330);
      reveal.handleControlMessage(
        done("C", "One two three four five six.", status),
      );
      const frozen = lastText("C")!;
      expect(frozen.length).toBeLessThan("One two three four five six.".length);
      vi.advanceTimersByTime(5_000);
      expect(lastText("C")).toBe(frozen);
      expect(updates.at(-1)).toMatchObject({ final: true, text: frozen });
    },
  );

  it("two turns settle: the first is completed before the second starts, a frozen one stays frozen", () => {
    const { reveal, lastText } = setup();
    reveal.handleControlMessage(delta("E", "Alpha beta gamma delta."));
    reveal.handleControlMessage(speech("agent_speaking_start"));
    reveal.handleControlMessage(done("E", "Alpha beta gamma delta."));
    reveal.handleControlMessage(delta("F", "Epsilon zeta."));
    expect(lastText("E")).toBe("Alpha beta gamma delta.");
    reveal.handleControlMessage(speech("agent_speaking_start"));
    reveal.handleControlMessage(done("F", "Epsilon zeta."));
    vi.advanceTimersByTime(5_000);
    expect(lastText("F")).toBe("Epsilon zeta.");

    reveal.handleControlMessage(delta("G", "Alpha beta gamma."));
    reveal.handleControlMessage(speech("agent_speaking_start"));
    reveal.handleControlMessage(speech("barge_in"));
    reveal.handleControlMessage(done("G", "Alpha beta gamma.", "interrupted"));
    reveal.handleControlMessage(delta("H", "Delta."));
    vi.advanceTimersByTime(5_000);
    expect(lastText("G")).toBe("Alpha");
    expect(lastText("H")).toBe("Delta.");
  });

  it("carries inReplyTo and pairs by turnId, not adjacency", () => {
    const { reveal, updates } = setup();
    reveal.handleControlMessage(delta("A", "First.", { inReplyTo: "u1" }));
    reveal.handleControlMessage(delta("B", "Second.", { inReplyTo: "u2" }));
    reveal.handleControlMessage(speech("agent_speaking_start"));
    vi.advanceTimersByTime(5_000);
    const forB = updates.filter((u) => u.turnId === "B");
    expect(forB.length).toBeGreaterThan(0);
    expect(forB.every((u) => u.inReplyTo === "u2")).toBe(true);
  });

  it("dispose clears timers: nothing is reported afterwards", () => {
    const { reveal, updates } = setup();
    reveal.handleControlMessage(delta("A", "One two three four five."));
    reveal.handleControlMessage(speech("agent_speaking_start"));
    const before = updates.length;
    reveal.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(updates.length).toBe(before);
  });

  it("a throwing callback does not break the reveal", () => {
    const reveal = createAgentTextReveal({
      onAgentText: () => {
        throw new Error("customer bug");
      },
    });
    reveal.handleControlMessage(delta("A", "One two."));
    reveal.handleControlMessage(speech("agent_speaking_start"));
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
  });
});

describe("createAgentTextReveal (immediate)", () => {
  it('"immediate" shows each spoken sentence at once, one line per turnId, ignoring speech events', () => {
    const { reveal, updates } = setup("immediate");
    reveal.handleControlMessage(delta("A", "One two."));
    reveal.handleControlMessage(speech("agent_speaking_start"));
    reveal.handleControlMessage(delta("A", "Three."));
    reveal.handleControlMessage(done("A", "One two. Three."));
    expect(updates).toEqual([
      { turnId: "A", text: "One two.", spoken: true, final: false },
      { turnId: "A", text: "One two. Three.", spoken: true, final: false },
      { turnId: "A", text: "One two. Three.", spoken: true, final: true },
    ]);
  });
});

describe("createAgentTextReveal (typed turns)", () => {
  it("typed turn is reported at once and the trailing chat_reply adds nothing", () => {
    const { reveal, updates } = setup();
    reveal.handleControlMessage({
      type: "assistant_delta",
      turnId: "T",
      text: "Hello there.",
    });
    reveal.handleControlMessage({
      type: "assistant_done",
      turnId: "T",
      text: "Hello there.",
    });
    reveal.handleControlMessage({ type: "chat_reply", text: "Hello there." });
    expect(updates).toEqual([
      { turnId: "T", text: "Hello there.", spoken: false, final: false },
      { turnId: "T", text: "Hello there.", spoken: false, final: true },
    ]);
  });

  it("ignores empty chunks, messages without turnId and other types", () => {
    const { reveal, updates } = setup();
    reveal.handleControlMessage({
      type: "assistant_delta",
      turnId: "T",
      text: "  ",
    });
    reveal.handleControlMessage({ type: "assistant_delta", text: "x" });
    reveal.handleControlMessage({ type: "chat_reply", text: "x" });
    expect(updates).toEqual([]);
  });
});
