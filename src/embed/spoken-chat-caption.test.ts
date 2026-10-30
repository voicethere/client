import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpokenChatCaption } from "./spoken-chat-caption.js";

describe("createSpokenChatCaption", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("disabled → immediate full text, one upsert", () => {
    const upserts: Array<[string, string]> = [];
    const caption = createSpokenChatCaption({
      enabled: false,
      onUpsert: (id, text) => upserts.push([id, text]),
    });

    caption.handleControlMessage({
      type: "chat_reply",
      text: "Hello there friend",
      stream: true,
      utteranceId: "u1",
    });

    expect(upserts).toEqual([["u1", "Hello there friend"]]);
    caption.dispose();
  });

  it("enabled=false ignores stream:true (full dump)", () => {
    const upserts: string[] = [];
    const caption = createSpokenChatCaption({
      enabled: false,
      onUpsert: (_id, text) => upserts.push(text),
    });

    caption.handleControlMessage({
      type: "chat_reply",
      text: "One two three",
      stream: true,
    });

    expect(upserts).toEqual(["One two three"]);
  });

  it("enabled + chat_reply without stream, then agent_speaking_start → words over time", () => {
    const upserts: Array<[string, string]> = [];
    const caption = createSpokenChatCaption({
      enabled: true,
      onUpsert: (id, text) => upserts.push([id, text]),
    });

    caption.handleControlMessage({
      type: "chat_reply",
      text: "Hello brave world",
      utteranceId: "send-then-play",
      durationMs: 900,
    });

    expect(upserts).toEqual([]);

    caption.handleControlMessage({
      type: "speech_event",
      event: "agent_speaking_start",
    });

    expect(upserts).toEqual([["send-then-play", "Hello"]]);

    vi.advanceTimersByTime(300);
    expect(upserts.at(-1)).toEqual(["send-then-play", "Hello brave"]);

    vi.advanceTimersByTime(300);
    expect(upserts.at(-1)).toEqual(["send-then-play", "Hello brave world"]);
    caption.dispose();
  });

  it("enabled + chat_reply without stream, no speaking_start → full text after 400ms", () => {
    const upserts: Array<[string, string]> = [];
    const caption = createSpokenChatCaption({
      enabled: true,
      onUpsert: (id, text) => upserts.push([id, text]),
    });

    caption.handleControlMessage({
      type: "chat_reply",
      text: "Data only message",
      utteranceId: "data-only",
    });

    expect(upserts).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(upserts).toEqual([["data-only", "Data only message"]]);

    vi.advanceTimersByTime(2000);
    expect(upserts).toEqual([["data-only", "Data only message"]]);
    caption.dispose();
  });

  it("enabled + stream:true, no speaking_start → typewrite after 400ms fallback", () => {
    const upserts: Array<[string, string]> = [];
    const caption = createSpokenChatCaption({
      enabled: true,
      onUpsert: (id, text) => upserts.push([id, text]),
    });

    caption.handleControlMessage({
      type: "chat_reply",
      text: "One two three",
      stream: true,
      utteranceId: "stream-fallback",
      durationMs: 900,
    });

    expect(upserts).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(upserts).toEqual([["stream-fallback", "One"]]);

    vi.advanceTimersByTime(300);
    expect(upserts.at(-1)).toEqual(["stream-fallback", "One two"]);
    caption.dispose();
  });

  it("enabled + chat_reply stream → no full dump before start; words over time", () => {
    const upserts: Array<[string, string]> = [];
    const caption = createSpokenChatCaption({
      enabled: true,
      onUpsert: (id, text) => upserts.push([id, text]),
    });

    caption.handleControlMessage({
      type: "chat_reply",
      text: "One two three",
      stream: true,
      utteranceId: "u-stream",
      durationMs: 900,
    });

    expect(upserts).toEqual([]);

    caption.handleControlMessage({
      type: "speech_event",
      event: "agent_speaking_start",
    });

    expect(upserts).toEqual([["u-stream", "One"]]);

    vi.advanceTimersByTime(300);
    expect(upserts).toEqual([
      ["u-stream", "One"],
      ["u-stream", "One two"],
    ]);

    vi.advanceTimersByTime(300);
    expect(upserts.at(-1)).toEqual(["u-stream", "One two three"]);
    caption.dispose();
  });

  it("agent_speaking_end snaps to remainder", () => {
    const upserts: string[] = [];
    const caption = createSpokenChatCaption({
      enabled: true,
      onUpsert: (_id, text) => upserts.push(text),
    });

    caption.handleControlMessage({
      type: "chat_reply",
      text: "Alpha beta gamma",
      stream: true,
      utteranceId: "u-end",
    });
    caption.handleControlMessage({
      type: "speech_event",
      event: "agent_speaking_start",
    });

    expect(upserts).toEqual(["Alpha"]);

    caption.handleControlMessage({
      type: "speech_event",
      event: "agent_speaking_end",
    });

    expect(upserts.at(-1)).toBe("Alpha beta gamma");
    caption.dispose();
  });

  it("barge_in freezes (remaining words never appear)", () => {
    const upserts: string[] = [];
    const caption = createSpokenChatCaption({
      enabled: true,
      onUpsert: (_id, text) => upserts.push(text),
    });

    caption.handleControlMessage({
      type: "chat_reply",
      text: "One two three four",
      stream: true,
      utteranceId: "u-barge",
      durationMs: 1200,
    });
    caption.handleControlMessage({
      type: "speech_event",
      event: "agent_speaking_start",
    });

    vi.advanceTimersByTime(300);
    expect(upserts.at(-1)).toBe("One two");

    caption.handleControlMessage({
      type: "speech_event",
      event: "barge_in",
    });

    vi.advanceTimersByTime(5000);
    expect(upserts.at(-1)).toBe("One two");
    caption.dispose();
  });

  it("two sequential utterances do not create overlapping wrong text", () => {
    const upserts: Array<[string, string]> = [];
    const caption = createSpokenChatCaption({
      enabled: true,
      onUpsert: (id, text) => upserts.push([id, text]),
    });

    caption.handleControlMessage({
      type: "chat_reply",
      text: "First line",
      stream: true,
      utteranceId: "first",
    });
    caption.handleControlMessage({
      type: "speech_event",
      event: "agent_speaking_start",
    });
    caption.handleControlMessage({
      type: "speech_event",
      event: "agent_speaking_end",
    });

    caption.handleControlMessage({
      type: "chat_reply",
      text: "Second line",
      stream: true,
      utteranceId: "second",
    });
    caption.handleControlMessage({
      type: "speech_event",
      event: "agent_speaking_start",
    });
    caption.handleControlMessage({
      type: "speech_event",
      event: "agent_speaking_end",
    });

    const firstSnapshots = upserts
      .filter(([id]) => id === "first")
      .map(([, t]) => t);
    const secondSnapshots = upserts
      .filter(([id]) => id === "second")
      .map(([, t]) => t);

    expect(firstSnapshots.every((t) => !t.includes("Second"))).toBe(true);
    expect(secondSnapshots.every((t) => !t.includes("First"))).toBe(true);
    expect(secondSnapshots.at(-1)).toBe("Second line");
    caption.dispose();
  });

  it("does not treat speech_event agent text as a new bubble when enabled", () => {
    const upserts: string[] = [];
    const caption = createSpokenChatCaption({
      enabled: true,
      onUpsert: (_id, text) => upserts.push(text),
    });

    caption.handleControlMessage({
      type: "speech_event",
      event: "agent_something",
      text: "Should not appear",
    });

    expect(upserts).toEqual([]);
    caption.dispose();
  });
});

describe("createSpokenChatCaption streamed reply (partial: true)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const upserts: Array<[string, string]> = [];
    const caption = createSpokenChatCaption({
      enabled: true,
      onUpsert: (id, text) => upserts.push([id, text]),
    });
    const reply = (text: string, partial: boolean, id = "t1") =>
      caption.handleControlMessage({
        type: "chat_reply",
        utteranceId: id,
        stream: true,
        text,
        ...(partial ? { partial: true } : {}),
      });
    const speech = (event: string) =>
      caption.handleControlMessage({ type: "speech_event", event });
    const last = () => upserts[upserts.length - 1]?.[1];
    return { caption, upserts, reply, speech, last };
  };

  it("streamed reply grows without reset", () => {
    const { caption, upserts, reply, speech, last } = setup();
    reply("One two.", true);
    speech("agent_speaking_start");
    expect(last()).toBe("One");
    reply("One two. Three four.", true);
    for (const [, text] of upserts) {
      expect("One two. Three four.".startsWith(text)).toBe(true);
    }
    expect(last()).toBe("One");
    vi.advanceTimersByTime(330 * 3);
    expect(last()).toBe("One two. Three four.");
    const lengths = upserts.map(([, t]) => t.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    caption.dispose();
  });

  it("speaking_end pauses, start resumes", () => {
    const { caption, reply, speech, last } = setup();
    reply("a b c d e f", true);
    speech("agent_speaking_start");
    vi.advanceTimersByTime(330);
    expect(last()).toBe("a b");
    speech("agent_speaking_end");
    vi.advanceTimersByTime(330 * 3);
    expect(last()).toBe("a b");
    speech("agent_speaking_start");
    vi.advanceTimersByTime(330);
    expect(last()).toBe("a b c");
    caption.dispose();
  });

  it("final text completes without jump", () => {
    const { caption, upserts, reply, speech, last } = setup();
    reply("one two", true);
    speech("agent_speaking_start");
    expect(last()).toBe("one");
    reply("one two three four five six", false);
    expect(last()).toBe("one");
    vi.advanceTimersByTime(330);
    expect(last()).toBe("one two");
    speech("agent_speaking_end");
    expect(last()).toBe("one two");
    speech("agent_speaking_start");
    vi.advanceTimersByTime(330);
    expect(last()).toBe("one two three");
    vi.advanceTimersByTime(330 * 10);
    expect(last()).toBe("one two three four five six");
    const count = upserts.length;
    vi.advanceTimersByTime(330 * 10);
    expect(upserts.length).toBe(count);
    caption.dispose();
  });

  it("barge_in freezes a streamed reply", () => {
    const { caption, reply, speech, last } = setup();
    reply("a b c", true);
    speech("agent_speaking_start");
    vi.advanceTimersByTime(330);
    expect(last()).toBe("a b");
    speech("barge_in");
    reply("a b c d e", true);
    reply("a b c d e f", false);
    vi.advanceTimersByTime(330 * 10);
    expect(last()).toBe("a b");
    caption.dispose();
  });

  it("completed id re-sent is a no-op", () => {
    const { caption, upserts, reply, speech } = setup();
    reply("a b", true);
    speech("agent_speaking_start");
    reply("a b", false);
    vi.advanceTimersByTime(330 * 3);
    const count = upserts.length;
    reply("a b", false);
    vi.advanceTimersByTime(330 * 10);
    expect(upserts.length).toBe(count);
    caption.dispose();
  });

  it("two streamed ids keep their own text", () => {
    const { caption, upserts, reply, speech } = setup();
    reply("alpha one", true, "A");
    speech("agent_speaking_start");
    reply("beta one", true, "B");
    reply("alpha one two", true, "A");
    speech("agent_speaking_start");
    vi.advanceTimersByTime(330 * 5);
    for (const [id, text] of upserts) {
      const expected = id === "A" ? "alpha one two" : "beta one";
      expect(expected.startsWith(text)).toBe(true);
    }
    caption.dispose();
  });
});
