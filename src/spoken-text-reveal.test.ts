import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import type { SpokenTurnUpsertInfo as BrowserInfo } from "./browser/browser-session.js";
import type { SpokenTurnUpsertInfo as EmbedInfo } from "./embed/index.js";
import type { SpokenTurnUpsertInfo as RootInfo } from "./index.js";
import type { SpokenTurnUpsertInfo as NodeInfo } from "./node/index.js";
import {
  createAgentTextReveal,
  createSpokenChatCaption,
  type AgentTextUpdate,
  type SpokenTurnUpsertInfo,
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
    reveal.handleControlMessage(speech("agent_speaking_start"));
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

describe("spoken turns never reveal before audio", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a)+(b) a spoken delta shows nothing without a start, then words begin at the start", () => {
    const { reveal, updates, lastText } = setup();
    reveal.handleControlMessage(delta("A", "One two three."));
    vi.advanceTimersByTime(4_900);
    expect(updates).toEqual([]);
    reveal.handleControlMessage(speech("agent_speaking_start"));
    expect(lastText("A")).toBe("One");
  });

  it("(c) a completed done without any start shows the full text as final after 5000 ms", () => {
    const { reveal, updates } = setup();
    reveal.handleControlMessage(delta("A", "One two three."));
    reveal.handleControlMessage(done("A", "One two three."));
    vi.advanceTimersByTime(4_999);
    expect(updates).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(updates).toEqual([
      { turnId: "A", text: "One two three.", spoken: true, final: true },
    ]);
  });

  it("(c2) a start before the 5000 ms bound cancels the fallback and paces instead", () => {
    const { reveal, updates } = setup();
    reveal.handleControlMessage(done("A", "One two three."));
    vi.advanceTimersByTime(2_000);
    reveal.handleControlMessage(speech("agent_speaking_start"));
    expect(updates.map((u) => u.text)).toEqual(["One"]);
    vi.advanceTimersByTime(330);
    expect(updates.at(-1)!.text).toBe("One two");
  });

  it("(d) an interrupted done before any start emits nothing", () => {
    const { reveal, updates } = setup();
    reveal.handleControlMessage(delta("A", "One two three."));
    reveal.handleControlMessage(done("A", "One two three.", "interrupted"));
    vi.advanceTimersByTime(20_000);
    expect(updates).toEqual([]);
  });
});

describe("a late message for an earlier turn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles only its own line and does not reset the current turn", () => {
    const { reveal, updates, lastText } = setup();
    reveal.handleControlMessage(delta("A", "One two three four."));
    reveal.handleControlMessage(speech("agent_speaking_start"));
    expect(lastText("A")).toBe("One");
    reveal.handleControlMessage(speech("barge_in"));
    reveal.handleControlMessage(delta("B", "One two three four."));
    reveal.handleControlMessage(speech("agent_speaking_start"));
    expect(lastText("B")).toBe("One");
    reveal.handleControlMessage(
      done("A", "One two three four.", "interrupted"),
    );
    const forA = updates.filter((u) => u.turnId === "A");
    expect(forA.at(-1)).toEqual({
      turnId: "A",
      text: "One",
      spoken: true,
      final: true,
    });
    expect(forA.filter((u) => u.final)).toHaveLength(1);
    expect(lastText("B")).toBe("One");
    vi.advanceTimersByTime(330);
    expect(lastText("B")).toBe("One two");
    expect(updates.filter((u) => u.turnId === "B").map((u) => u.text)).toEqual([
      "One",
      "One two",
    ]);
  });

  it("a late completed done emits the full text as final for its own turn", () => {
    const { reveal, updates, lastText } = setup();
    reveal.handleControlMessage(delta("A", "Alpha beta."));
    reveal.handleControlMessage(delta("B", "Gamma."));
    reveal.handleControlMessage(done("A", "Alpha beta."));
    expect(updates.at(-1)).toEqual({
      turnId: "A",
      text: "Alpha beta.",
      spoken: true,
      final: true,
    });
    expect(lastText("B")).toBeUndefined();
  });
});

describe("paceChatReply", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("false: chat_reply is shown at once while spoken turns are still paced", () => {
    const upserts: Array<[string, string]> = [];
    const caption = createSpokenChatCaption({
      enabled: true,
      paceChatReply: false,
      onUpsert: (id, text) => upserts.push([id, text]),
    });
    caption.handleControlMessage({ type: "chat_reply", text: "One two three" });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]![1]).toBe("One two three");
    caption.handleControlMessage(delta("S", "Four five six."));
    caption.handleControlMessage(speech("agent_speaking_start"));
    expect(upserts.at(-1)).toEqual(["S", "Four"]);
    caption.dispose();
  });
});

describe("SpokenTurnUpsertInfo", () => {
  it("is exported with the same shape from every entry", () => {
    expectTypeOf<RootInfo>().toEqualTypeOf<SpokenTurnUpsertInfo>();
    expectTypeOf<BrowserInfo>().toEqualTypeOf<RootInfo>();
    expectTypeOf<EmbedInfo>().toEqualTypeOf<RootInfo>();
    expectTypeOf<NodeInfo>().toEqualTypeOf<RootInfo>();
    expectTypeOf<RootInfo>().toEqualTypeOf<{
      final: boolean;
      inReplyTo?: string;
    }>();
  });
});

// A spoken turn whose audio started must never end without a visible line: the listener heard
// part of the answer. A barge-in (often the listener's own speakers echoing into the mic) can
// land before the reveal showed its first word. Lines are keyed by turnId in first-seen order.
describe("first sentence once audio started", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function linesSetup() {
    const { reveal, updates } = setup();
    const feed = (payload: Record<string, unknown>) =>
      reveal.handleControlMessage(payload);
    const getLines = () => {
      const order: string[] = [];
      const latest = new Map<string, string>();
      for (const u of updates) {
        if (!u.text) continue;
        if (!latest.has(u.turnId)) order.push(u.turnId);
        latest.set(u.turnId, u.text);
      }
      return order.map((id) => `[agent] ${latest.get(id)}`);
    };
    return { feed, getLines, reveal, updates };
  }

  it("barge-in within 400 ms of the first delta still shows the first sentence", () => {
    const { feed, getLines } = linesSetup();
    feed(speech("agent_speaking_start"));
    feed(delta("H", "Sure, here it is."));
    vi.advanceTimersByTime(200);
    feed(speech("barge_in"));
    feed(delta("H", "More text follows."));
    feed(done("H", "Sure, here it is. More text follows.", "interrupted"));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual(["[agent] Sure, here it is."]);
  });

  it("barge-in before the first word on a later turn still shows its first sentence", () => {
    const { feed, getLines } = linesSetup();
    feed(delta("E", "Alpha beta."));
    feed(speech("agent_speaking_start"));
    feed(done("E", "Alpha beta."));
    feed(speech("agent_speaking_end"));
    vi.advanceTimersByTime(5000);
    feed(speech("agent_speaking_start"));
    feed(delta("F", "Gamma delta epsilon."));
    feed(speech("barge_in"));
    feed(done("F", "Gamma delta epsilon. Zeta.", "interrupted"));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual([
      "[agent] Alpha beta.",
      "[agent] Gamma delta epsilon.",
    ]);
  });

  it("start, barge-in, end, then the turn's delta and interrupted done still shows its first sentence", () => {
    const { feed, getLines } = linesSetup();
    feed(speech("agent_speaking_start"));
    feed(speech("barge_in"));
    feed(speech("agent_speaking_end"));
    feed(delta("B", "Sure, here it is."));
    feed(done("B", "Sure, here it is. More text follows.", "interrupted"));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual(["[agent] Sure, here it is."]);
  });

  it("start, barge-in without an end, then delta and interrupted done shows its first sentence", () => {
    const { feed, getLines } = linesSetup();
    feed(speech("agent_speaking_start"));
    feed(speech("barge_in"));
    feed(delta("B", "Sure, here it is."));
    feed(done("B", "Sure, here it is. More text follows.", "interrupted"));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual(["[agent] Sure, here it is."]);
  });

  it("a trailing start of a finished turn does not give the next turn audio", () => {
    const { feed, getLines } = linesSetup();
    feed(delta("E", "Alpha beta."));
    feed(speech("agent_speaking_start"));
    feed(done("E", "Alpha beta."));
    vi.advanceTimersByTime(5000);
    feed(speech("agent_speaking_start"));
    feed(speech("agent_speaking_end"));
    feed(delta("F", "Gamma delta."));
    feed(done("F", "Gamma delta.", "interrupted"));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual(["[agent] Alpha beta."]);
  });

  it("a barge-in on a finished turn's trailing audio does not freeze the next turn", () => {
    const { feed, getLines } = linesSetup();
    feed(delta("A", "Alpha beta."));
    feed(done("A", "Alpha beta."));
    vi.advanceTimersByTime(5000);
    feed(speech("agent_speaking_start"));
    feed(speech("barge_in"));
    feed(speech("agent_speaking_end"));
    vi.advanceTimersByTime(20_000);
    feed(delta("B", "One."));
    feed(speech("agent_speaking_start"));
    feed(delta("B", "Two."));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual(["[agent] Alpha beta.", "[agent] One. Two."]);
    feed(done("B", "One. Two."));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual(["[agent] Alpha beta.", "[agent] One. Two."]);
  });

  it("an unclaimed cut expires", () => {
    const { feed, getLines } = linesSetup();
    feed(speech("agent_speaking_start"));
    feed(speech("barge_in"));
    vi.advanceTimersByTime(2000);
    feed(delta("B", "Sure, here it is."));
    feed(done("B", "Sure, here it is. More text follows.", "interrupted"));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual([]);
  });

  it("a new unclaimed start after a cut start clears the cut", () => {
    const { feed, getLines } = linesSetup();
    feed(speech("agent_speaking_start"));
    feed(speech("barge_in"));
    feed(speech("agent_speaking_start"));
    feed(delta("B", "One two."));
    feed(speech("agent_speaking_start"));
    feed(delta("B", "Three."));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual(["[agent] One two. Three."]);
  });

  it("a start just before the turn's first delta paces it without a done", () => {
    const { feed, getLines } = linesSetup();
    feed(speech("agent_speaking_start"));
    feed(delta("S", "One sentence only."));
    vi.advanceTimersByTime(500);
    expect(getLines()).toEqual(["[agent] One"]);
    vi.advanceTimersByTime(600);
    expect(getLines()).toEqual(["[agent] One sentence only."]);
  });

  it("dispose while a finished turn is still pacing shows its full text", () => {
    const { feed, getLines, reveal, updates } = linesSetup();
    feed(speech("agent_speaking_start"));
    feed(delta("P", "One two three four five six."));
    feed(done("P", "One two three four five six."));
    vi.advanceTimersByTime(660);
    expect(getLines()[0]!.length).toBeLessThan(
      "[agent] One two three four five six.".length,
    );
    reveal.dispose();
    expect(getLines()).toEqual(["[agent] One two three four five six."]);
    expect(updates.at(-1)!.final).toBe(true);
  });

  it("an interrupted turn whose audio never started shows nothing", () => {
    const { feed, getLines } = linesSetup();
    feed(delta("I", "Never spoken."));
    feed(done("I", "Never spoken.", "interrupted"));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual([]);
  });

  it("assistant_done before any agent_speaking_start reveals the full line", () => {
    const { feed, getLines } = linesSetup();
    feed(delta("J", "Here is the answer."));
    feed(done("J", "Here is the answer."));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual(["[agent] Here is the answer."]);
    feed(speech("agent_speaking_start"));
    feed(speech("agent_speaking_end"));
    expect(getLines()).toEqual(["[agent] Here is the answer."]);
  });

  // Client timing: L's audio has not started, so L stays hidden until its own start or, after a
  // completed done, the 5000 ms fallback (no 400 ms fallback).
  it("a second turn starting before the first is done keeps a line for the first", () => {
    const { feed, getLines } = linesSetup();
    feed(speech("agent_speaking_start"));
    feed(delta("K", "First answer here."));
    feed(delta("L", "Second answer."));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual(["[agent] First answer here."]);
    feed(done("K", "First answer here. And more."));
    feed(done("L", "Second answer."));
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual([
      "[agent] First answer here. And more.",
      "[agent] Second answer.",
    ]);
  });

  it("dispose (disconnect or reconnect) mid-turn keeps the first sentence once audio started", () => {
    const { feed, getLines, reveal } = linesSetup();
    feed(speech("agent_speaking_start"));
    feed(delta("M", "Hello from the agent."));
    reveal.dispose();
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual(["[agent] Hello from the agent."]);
  });

  it("dispose before the turn's audio started shows nothing", () => {
    const { feed, getLines, reveal } = linesSetup();
    feed(delta("N", "Not yet spoken."));
    reveal.dispose();
    vi.advanceTimersByTime(5000);
    expect(getLines()).toEqual([]);
  });

  it("paces with timers only, so a hidden tab without requestAnimationFrame still reveals", () => {
    vi.stubGlobal("requestAnimationFrame", () => {
      throw new Error("requestAnimationFrame must not drive the spoken reveal");
    });
    try {
      const { feed, getLines } = linesSetup();
      feed(delta("O", "One two three."));
      feed(speech("agent_speaking_start"));
      vi.advanceTimersByTime(5000);
      expect(getLines()).toEqual(["[agent] One two three."]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
