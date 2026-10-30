const START_FALLBACK_MS = 400;
/**
 * A completed spoken turn whose audio never starts shows its full text after this wait.
 * Internal: spoken turns never use START_FALLBACK_MS, they wait for `agent_speaking_start`.
 */
const SPOKEN_START_FALLBACK_MS = 5000;
const DEFAULT_MS_PER_WORD = 330;
/**
 * speech_event carries no turnId, and the agent sends each sentence's assistant_delta before
 * its speak, so a turn's first delta trails its own audio start only by transport skew. A cut
 * start (agent_speaking_start then barge_in) not claimed by a turn within this window belonged
 * to an earlier turn.
 */
const UNCLAIMED_CUT_MS = 1500;
const COMPLETED_IDS_MAX = 32;

/** Passed as third `onUpsert` argument for spoken `assistant_*` turns only. */
export type SpokenTurnUpsertInfo = {
  /** The turn's text is complete and this is all that will ever be shown. */
  final: boolean;
  inReplyTo?: string;
};

export type SpokenChatCaptionOptions = {
  enabled: boolean;
  /**
   * Default `true`. When `false`, a plain `chat_reply` is shown at once (no pacing, no start
   * wait) while spoken `assistant_*` turns are still paced by speech events.
   */
  paceChatReply?: boolean;
  onUpsert: (
    utteranceId: string,
    visibleText: string,
    info?: SpokenTurnUpsertInfo,
  ) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

type UtteranceState = {
  utteranceId: string;
  words: string[];
  visibleWordCount: number;
  intervalMs: number;
  frozen: boolean;
  revealStarted: boolean;
  waitingForStart: boolean;
  streamExplicit: boolean;
  /** Set once any chat_reply for this utterance carried `partial: true`. */
  streamed: boolean;
  /** A chat_reply without `partial` arrived: the words are complete. */
  final: boolean;
  /** Streamed only: between speech chunks, the reveal waits for the next start. */
  paused: boolean;
  startTimeoutId?: ReturnType<typeof setTimeout>;
  tickTimeoutId?: ReturnType<typeof setTimeout>;
};

type SpokenTurn = {
  turnId: string;
  /** Full text so far (deltas appended) or the final text. */
  text: string;
  inReplyTo?: string;
  done: boolean;
  /** Barge-in or a non-completed status: the line stays at what was visible. */
  frozen: boolean;
  lastEmitted: string;
  finalReported: boolean;
  /** First delta (first spoken sentence): the minimum line once audio started. */
  firstChunk: string;
  /** An agent_speaking_start belongs to this turn. */
  audioStarted: boolean;
};

export type SpokenChatCaption = {
  handleControlMessage: (payload: Record<string, unknown>) => void;
  setEnabled: (enabled: boolean) => void;
  dispose: () => void;
};

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function incomingAgentTextFromControlMessage(
  payload: Record<string, unknown>,
  options: { ignoreSpeechEventAgentText: boolean },
): string | null {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (
    type === "session_error" ||
    type === "agent_error" ||
    type === "session_close" ||
    type === "session_reconnect_token"
  ) {
    return null;
  }

  if (type === "speech_event") {
    if (options.ignoreSpeechEventAgentText) {
      return null;
    }
    const event = typeof payload.event === "string" ? payload.event : "";
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) return null;
    if (event.includes("final") || event.includes("agent")) {
      return text;
    }
    return null;
  }

  if (type === "chat_reply") {
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    return text || null;
  }

  if (type === "chat_broadcast") {
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    return text || null;
  }

  if (type === "chat") {
    const role = typeof payload.role === "string" ? payload.role : "";
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) return null;
    if (role === "agent" || role === "assistant") {
      return text;
    }
    return null;
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (
    text &&
    (type === "agent_message" || type === "message" || type === "assistant")
  ) {
    return text;
  }

  return null;
}

export function createSpokenChatCaption(
  opts: SpokenChatCaptionOptions,
): SpokenChatCaption {
  let enabled = opts.enabled;
  let state: UtteranceState | null = null;
  let utteranceCounter = 0;
  const completed = new Map<string, string>();
  const spokenTurns = new Map<string, SpokenTurn>();
  // The caption follows one utterance at a time: a new turnId drops the previous state and
  // leaves its line at a prefix. A finished, unfrozen turn is settled to its full text first.
  let currentSpoken: SpokenTurn | null = null;
  // agent_speaking_start seen while no unfinished spoken turn was current: its audio belongs to
  // the next turn (the start can arrive before that turn's first delta).
  let unclaimedStart = false;
  // A barge_in landed while that start was unclaimed: the turn that claims it is already cut
  // off, so it is frozen from its first delta.
  let unclaimedBargeIn = false;
  let unclaimedCutTimer: ReturnType<typeof setTimeout> | undefined;

  /** Single send path for every visible change; spoken turns carry `info`. */
  const emit = (utteranceId: string, visibleText: string): void => {
    const turn = spokenTurns.get(utteranceId);
    if (!turn) {
      opts.onUpsert(utteranceId, visibleText);
      return;
    }
    turn.lastEmitted = visibleText;
    const final = turn.done && (turn.frozen || visibleText === turn.text);
    if (final) turn.finalReported = true;
    opts.onUpsert(utteranceId, visibleText, {
      final,
      ...(turn.inReplyTo !== undefined ? { inReplyTo: turn.inReplyTo } : {}),
    });
  };

  const setTimeoutFn = opts.setTimeout ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeout ?? clearTimeout;

  const newUtteranceId = (): string => {
    utteranceCounter += 1;
    return `utterance-${utteranceCounter}`;
  };

  const clearUtteranceTimers = (utterance: UtteranceState): void => {
    if (utterance.startTimeoutId !== undefined) {
      clearTimeoutFn(utterance.startTimeoutId);
      utterance.startTimeoutId = undefined;
    }
    if (utterance.tickTimeoutId !== undefined) {
      clearTimeoutFn(utterance.tickTimeoutId);
      utterance.tickTimeoutId = undefined;
    }
  };

  const visibleTextFor = (utterance: UtteranceState): string => {
    if (utterance.visibleWordCount <= 0) return "";
    return utterance.words.slice(0, utterance.visibleWordCount).join(" ");
  };

  const upsertCurrent = (): void => {
    if (!state) return;
    emit(state.utteranceId, visibleTextFor(state));
  };

  const markCompleted = (utterance: UtteranceState): void => {
    completed.delete(utterance.utteranceId);
    completed.set(utterance.utteranceId, utterance.words.join(" "));
    while (completed.size > COMPLETED_IDS_MAX) {
      const oldest = completed.keys().next().value;
      if (oldest === undefined) break;
      completed.delete(oldest);
    }
  };

  /** A streamed utterance is done when its text is final and fully shown. */
  const finishStreamedIfComplete = (utterance: UtteranceState): void => {
    if (
      !utterance.streamed ||
      !utterance.final ||
      utterance.frozen ||
      utterance.visibleWordCount < utterance.words.length
    ) {
      return;
    }
    clearUtteranceTimers(utterance);
    markCompleted(utterance);
    if (state === utterance) {
      state = null;
    }
  };

  const scheduleNextWord = (utterance: UtteranceState): void => {
    if (
      utterance.frozen ||
      utterance.paused ||
      utterance.tickTimeoutId !== undefined ||
      utterance.visibleWordCount >= utterance.words.length
    ) {
      return;
    }
    utterance.tickTimeoutId = setTimeoutFn(() => {
      utterance.tickTimeoutId = undefined;
      if (!state || state !== utterance || utterance.frozen) return;
      if (utterance.paused) return;
      utterance.visibleWordCount += 1;
      upsertCurrent();
      scheduleNextWord(utterance);
      finishStreamedIfComplete(utterance);
    }, utterance.intervalMs);
  };

  const startReveal = (utterance: UtteranceState): void => {
    if (utterance.revealStarted || utterance.frozen) return;
    utterance.revealStarted = true;
    utterance.waitingForStart = false;
    if (utterance.startTimeoutId !== undefined) {
      clearTimeoutFn(utterance.startTimeoutId);
      utterance.startTimeoutId = undefined;
    }
    if (utterance.words.length === 0) {
      upsertCurrent();
      return;
    }
    if (utterance.visibleWordCount === 0) {
      utterance.visibleWordCount = 1;
    }
    upsertCurrent();
    if (utterance.visibleWordCount < utterance.words.length) {
      scheduleNextWord(utterance);
    }
    finishStreamedIfComplete(utterance);
  };

  const snapToFull = (utterance: UtteranceState): void => {
    if (utterance.frozen) return;
    clearUtteranceTimers(utterance);
    utterance.revealStarted = true;
    utterance.waitingForStart = false;
    utterance.visibleWordCount = utterance.words.length;
    emit(utterance.utteranceId, utterance.words.join(" "));
    if (state === utterance) {
      state = null;
    }
  };

  const resetUtteranceState = (): void => {
    if (state) {
      clearUtteranceTimers(state);
      state = null;
    }
  };

  const updateStreamed = (
    utterance: UtteranceState,
    text: string,
    partial: boolean,
  ): void => {
    if (utterance.frozen) return;
    const words = splitWords(text);
    const isPrefix =
      utterance.words.length <= words.length &&
      utterance.words.every((word, i) => word === words[i]);
    utterance.words = words;
    if (!partial) {
      utterance.final = true;
      // Once final, the line is never paused: assistant_done can arrive after
      // the last chunk's agent_speaking_end.
      utterance.paused = false;
    }
    if (!isPrefix) {
      utterance.visibleWordCount = Math.min(
        utterance.visibleWordCount,
        words.length,
      );
      if (utterance.revealStarted) upsertCurrent();
    }
    if (utterance.revealStarted) {
      scheduleNextWord(utterance);
    }
    finishStreamedIfComplete(utterance);
  };

  const handleChatReply = (
    payload: Record<string, unknown>,
    spoken = false,
  ): void => {
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) return;

    const utteranceId =
      typeof payload.utteranceId === "string" && payload.utteranceId.trim()
        ? payload.utteranceId.trim()
        : newUtteranceId();
    const durationMs =
      typeof payload.durationMs === "number" && payload.durationMs > 0
        ? payload.durationMs
        : undefined;
    const streamExplicit = payload.stream === true;
    const partial = payload.partial === true;

    if (!enabled) {
      resetUtteranceState();
      emit(utteranceId, text);
      return;
    }

    if (!spoken && opts.paceChatReply === false) {
      // Shown at once; a spoken turn's reveal in progress is left alone.
      emit(utteranceId, text);
      return;
    }

    if (state && state.utteranceId === utteranceId && state.streamed) {
      updateStreamed(state, text, partial);
      return;
    }

    if (completed.get(utteranceId) === splitWords(text).join(" ")) {
      return;
    }

    if (
      state &&
      state.utteranceId !== utteranceId &&
      state.revealStarted &&
      !state.frozen &&
      state.visibleWordCount < state.words.length
    ) {
      clearUtteranceTimers(state);
      state = null;
    } else if (state && state.utteranceId !== utteranceId) {
      resetUtteranceState();
    } else if (state && state.utteranceId === utteranceId) {
      clearUtteranceTimers(state);
    }

    const words = splitWords(text);
    const wordCount = Math.max(words.length, 1);
    const intervalMs =
      durationMs !== undefined ? durationMs / wordCount : DEFAULT_MS_PER_WORD;

    state = {
      utteranceId,
      words,
      visibleWordCount: 0,
      intervalMs,
      frozen: false,
      revealStarted: false,
      waitingForStart: true,
      streamExplicit,
      streamed: partial,
      final: !partial,
      paused: false,
    };

    // A spoken turn is never shown before its audio starts.
    if (spoken) return;

    state.startTimeoutId = setTimeoutFn(() => {
      if (!state?.waitingForStart || state.revealStarted) return;
      if (state.streamExplicit || state.streamed) {
        startReveal(state);
      } else {
        snapToFull(state);
      }
    }, START_FALLBACK_MS);
  };

  const handleSpeechEvent = (payload: Record<string, unknown>): void => {
    const event = typeof payload.event === "string" ? payload.event : "";
    if (event === "agent_speaking_start") {
      if (state?.streamed && !state.frozen) {
        state.paused = false;
        if (!state.revealStarted) {
          startReveal(state);
        } else {
          scheduleNextWord(state);
        }
        return;
      }
      if (state && (state.waitingForStart || !state.revealStarted)) {
        startReveal(state);
      }
      return;
    }
    if (event === "agent_speaking_end") {
      if (state?.streamed) {
        if (state.final) return;
        state.paused = true;
        if (state.tickTimeoutId !== undefined) {
          clearTimeoutFn(state.tickTimeoutId);
          state.tickTimeoutId = undefined;
        }
        return;
      }
      if (state) {
        clearUtteranceTimers(state);
        state.visibleWordCount = state.words.length;
        state.waitingForStart = false;
        upsertCurrent();
        state = null;
      }
      return;
    }
    if (event === "barge_in") {
      if (currentSpoken) currentSpoken.frozen = true;
      if (state) {
        clearUtteranceTimers(state);
        state.frozen = true;
        state.waitingForStart = false;
      }
    }
  };

  const clearUnclaimedCutTimer = (): void => {
    if (unclaimedCutTimer === undefined) return;
    clearTimeoutFn(unclaimedCutTimer);
    unclaimedCutTimer = undefined;
  };

  /** A turn whose audio started never ends without a line: show its first sentence. */
  const commitRevealed = (turn: SpokenTurn): void => {
    if (turn.lastEmitted || !turn.audioStarted || !turn.firstChunk) return;
    emit(turn.turnId, turn.firstChunk);
  };

  /**
   * A claimed start (it came before this turn's first delta) begins pacing after a 400 ms grace,
   * so a barge-in inside it still shows the first sentence.
   */
  const scheduleClaimedStart = (turn: SpokenTurn): void => {
    const pending = state;
    if (
      !turn.audioStarted ||
      turn.frozen ||
      !pending ||
      pending.utteranceId !== turn.turnId ||
      pending.revealStarted ||
      pending.frozen ||
      pending.startTimeoutId !== undefined
    ) {
      return;
    }
    pending.startTimeoutId = setTimeoutFn(() => {
      pending.startTimeoutId = undefined;
      if (state !== pending || pending.revealStarted || pending.frozen) return;
      startReveal(pending);
    }, START_FALLBACK_MS);
  };

  /** Spoken-turn bookkeeping for speech events; the caption's own pacing runs separately. */
  const trackSpokenSpeechEvent = (event: string): void => {
    if (event === "agent_speaking_start") {
      const current = currentSpoken;
      const waitingForStart =
        current !== null &&
        state !== null &&
        state.utteranceId === current.turnId &&
        !state.revealStarted &&
        !state.frozen;
      if (current && (!current.done || waitingForStart)) {
        current.audioStarted = true;
      } else {
        clearUnclaimedCutTimer();
        unclaimedBargeIn = false;
        unclaimedStart = true;
      }
      return;
    }
    if (event === "agent_speaking_end") {
      // An end right after a barge_in is the cut-off playback of the same, unclaimed turn.
      if (!unclaimedBargeIn) unclaimedStart = false;
      return;
    }
    if (event === "barge_in") {
      if (currentSpoken) commitRevealed(currentSpoken);
      if (unclaimedStart) {
        unclaimedBargeIn = true;
        clearUnclaimedCutTimer();
        unclaimedCutTimer = setTimeoutFn(() => {
          unclaimedCutTimer = undefined;
          unclaimedStart = false;
          unclaimedBargeIn = false;
        }, UNCLAIMED_CUT_MS);
      }
    }
  };

  /** Makes `turn` the current spoken turn; it claims an unclaimed audio start. */
  const claimSpoken = (turn: SpokenTurn): void => {
    if (currentSpoken !== turn) {
      currentSpoken = turn;
      if (unclaimedStart) {
        turn.audioStarted = true;
        if (unclaimedBargeIn) turn.frozen = true;
      }
    }
    unclaimedStart = false;
    unclaimedBargeIn = false;
    clearUnclaimedCutTimer();
  };

  const settleOtherSpoken = (turnId: string): void => {
    const previous = currentSpoken;
    if (!previous || previous.turnId === turnId) return;
    if (previous.done && !previous.frozen) {
      if (previous.lastEmitted !== previous.text) {
        emit(previous.turnId, previous.text);
      }
    } else {
      commitRevealed(previous);
    }
    currentSpoken = null;
  };

  /** Spoken `assistant_delta` / `assistant_done`, paired by `turnId` only. */
  const handleSpokenAssistant = (
    type: "assistant_delta" | "assistant_done",
    payload: Record<string, unknown>,
    turnId: string,
  ): void => {
    let turn = spokenTurns.get(turnId);
    const isNew = !turn;
    if (!turn) {
      turn = {
        turnId,
        text: "",
        done: false,
        frozen: false,
        lastEmitted: "",
        finalReported: false,
        firstChunk: "",
        audioStarted: false,
      };
      spokenTurns.set(turnId, turn);
      while (spokenTurns.size > COMPLETED_IDS_MAX) {
        const oldest = spokenTurns.keys().next().value;
        if (oldest === undefined || oldest === turnId) break;
        spokenTurns.delete(oldest);
      }
    }
    if (typeof payload.inReplyTo === "string" && payload.inReplyTo) {
      turn.inReplyTo = payload.inReplyTo;
    }
    const chunk = typeof payload.text === "string" ? payload.text.trim() : "";

    // A message for an earlier turn only settles its own line; the current reveal is untouched.
    if (enabled && !isNew && currentSpoken?.turnId !== turnId) {
      if (type === "assistant_delta") {
        if (chunk && !turn.done) {
          turn.text = turn.text ? `${turn.text} ${chunk}` : chunk;
        }
        return;
      }
      const lateStatus = typeof payload.status === "string" ? payload.status : "";
      if (
        lateStatus === "interrupted" ||
        lateStatus === "cancelled" ||
        lateStatus === "failed"
      ) {
        turn.frozen = true;
      }
      if (chunk) turn.text = chunk;
      turn.done = true;
      const shown = turn.frozen ? turn.lastEmitted : turn.text;
      if (shown && !(turn.finalReported && turn.lastEmitted === shown)) {
        emit(turnId, shown);
      }
      return;
    }

    if (type === "assistant_delta") {
      if (!chunk || turn.done) return;
      turn.text = turn.text ? `${turn.text} ${chunk}` : chunk;
      if (!enabled) {
        emit(turnId, turn.text);
        return;
      }
      settleOtherSpoken(turnId);
      claimSpoken(turn);
      if (!turn.firstChunk) turn.firstChunk = chunk;
      if (turn.frozen) {
        // Cut off before this delta: only the first sentence is shown.
        commitRevealed(turn);
        return;
      }
      handleChatReply(
        {
          type: "chat_reply",
          utteranceId: turnId,
          stream: true,
          partial: true,
          text: turn.text,
        },
        true,
      );
      scheduleClaimedStart(turn);
      return;
    }

    const status = typeof payload.status === "string" ? payload.status : "";
    const stopped =
      status === "interrupted" || status === "cancelled" || status === "failed";
    const text = chunk || turn.text;
    if (text) turn.text = text;
    turn.done = true;
    if (!enabled) {
      if (turn.text) emit(turnId, turn.text);
      return;
    }
    settleOtherSpoken(turnId);
    claimSpoken(turn);
    if (!turn.firstChunk) turn.firstChunk = turn.text;
    const wasFrozen = turn.frozen;
    if (stopped) turn.frozen = true;
    if (turn.text && !wasFrozen) {
      handleChatReply(
        {
          type: "chat_reply",
          utteranceId: turnId,
          stream: true,
          text: turn.text,
        },
        true,
      );
    }
    if (stopped) handleSpeechEvent({ event: "barge_in" });
    if (turn.frozen) commitRevealed(turn);
    const pending = state;
    if (
      !stopped &&
      pending &&
      pending.utteranceId === turnId &&
      !pending.revealStarted &&
      !pending.frozen &&
      !turn.audioStarted
    ) {
      // Audio that never starts must not hide a completed reply forever.
      clearUtteranceTimers(pending);
      pending.startTimeoutId = setTimeoutFn(() => {
        pending.startTimeoutId = undefined;
        if (state !== pending || pending.revealStarted || pending.frozen) return;
        snapToFull(pending);
      }, SPOKEN_START_FALLBACK_MS);
    }
    if (!stopped) scheduleClaimedStart(turn);
    // Nothing visible changed since the last emit but the turn is now final.
    if (
      !turn.finalReported &&
      turn.lastEmitted &&
      (turn.frozen || turn.lastEmitted === turn.text)
    ) {
      emit(turnId, turn.lastEmitted);
    }
  };

  const handleControlMessage = (payload: Record<string, unknown>): void => {
    const type = typeof payload.type === "string" ? payload.type : "";
    if (
      payload.spoken === true &&
      (type === "assistant_delta" || type === "assistant_done") &&
      typeof payload.turnId === "string" &&
      payload.turnId
    ) {
      handleSpokenAssistant(type, payload, payload.turnId);
      return;
    }
    if (type === "chat_reply") {
      handleChatReply(payload);
      return;
    }
    if (type === "speech_event") {
      if (enabled) {
        const event = typeof payload.event === "string" ? payload.event : "";
        if (event !== "barge_in") trackSpokenSpeechEvent(event);
        handleSpeechEvent(payload);
        if (event === "barge_in") trackSpokenSpeechEvent(event);
        return;
      }
    }

    const incoming = incomingAgentTextFromControlMessage(payload, {
      ignoreSpeechEventAgentText: enabled,
    });
    if (incoming) {
      resetUtteranceState();
      emit(newUtteranceId(), incoming);
    }
  };

  const dispose = (): void => {
    // Disconnect or reconnect: a finished turn still pacing shows its full text, and a turn
    // whose audio started keeps at least its first sentence.
    const current = currentSpoken;
    if (current && !current.frozen) {
      if (current.done) {
        if (current.lastEmitted !== current.text) {
          emit(current.turnId, current.text);
        }
      } else {
        commitRevealed(current);
      }
    }
    resetUtteranceState();
    spokenTurns.clear();
    currentSpoken = null;
    unclaimedStart = false;
    unclaimedBargeIn = false;
    clearUnclaimedCutTimer();
  };

  return {
    handleControlMessage,
    setEnabled: (next: boolean) => {
      enabled = next;
      if (!enabled) {
        dispose();
      }
    },
    dispose,
  };
}

/**
 * `playback` (default): spoken agent text is revealed word by word while the agent speaks.
 * `immediate`: spoken agent text is reported as soon as the agent hands it to speech.
 */
export type SpokenTextRevealMode = "playback" | "immediate";

const DEFAULT_SPOKEN_TEXT_REVEAL: SpokenTextRevealMode = "playback";

export type AgentTextUpdate = {
  turnId: string;
  /** Visible text of the whole turn so far (not a delta). */
  text: string;
  spoken: boolean;
  /** No further update for this turn will follow. */
  final: boolean;
  inReplyTo?: string;
};

export type AgentTextReveal = {
  handleControlMessage: (payload: Record<string, unknown>) => void;
  dispose: () => void;
};

/**
 * Maps the agent's `assistant_delta` / `assistant_done` messages onto `onAgentText`, one call per
 * visible change. Spoken turns go through {@link createSpokenChatCaption} (paced when `mode` is
 * `playback`); typed turns are passed through at once. The `chat_reply` that follows a typed
 * `assistant_done` carries the same text and is never reported.
 */
export function createAgentTextReveal(opts: {
  mode?: SpokenTextRevealMode;
  onAgentText: (update: AgentTextUpdate) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}): AgentTextReveal {
  const playback = (opts.mode ?? DEFAULT_SPOKEN_TEXT_REVEAL) === "playback";
  // A customer callback that throws must not break the control path or a timer tick.
  const report = (update: AgentTextUpdate): void => {
    try {
      opts.onAgentText(update);
    } catch {
      /* customer callback error */
    }
  };
  const caption = createSpokenChatCaption({
    enabled: playback,
    onUpsert: (turnId, text, info) => {
      if (!info) return;
      report({
        turnId,
        text,
        spoken: true,
        final: info.final,
        ...(info.inReplyTo !== undefined ? { inReplyTo: info.inReplyTo } : {}),
      });
    },
    setTimeout: opts.setTimeout,
    clearTimeout: opts.clearTimeout,
  });
  const typed = new Map<string, string>();

  const handleTyped = (
    type: "assistant_delta" | "assistant_done",
    payload: Record<string, unknown>,
    turnId: string,
  ): void => {
    const chunk = typeof payload.text === "string" ? payload.text.trim() : "";
    const known = typed.get(turnId) ?? "";
    const inReplyTo =
      typeof payload.inReplyTo === "string" && payload.inReplyTo
        ? { inReplyTo: payload.inReplyTo }
        : {};
    if (type === "assistant_delta") {
      if (!chunk) return;
      const text = known ? `${known} ${chunk}` : chunk;
      typed.set(turnId, text);
      report({
        turnId,
        text,
        spoken: false,
        final: false,
        ...inReplyTo,
      });
      return;
    }
    const text = chunk || known;
    typed.delete(turnId);
    if (!text) return;
    report({ turnId, text, spoken: false, final: true, ...inReplyTo });
  };

  return {
    handleControlMessage(payload) {
      const type = typeof payload.type === "string" ? payload.type : "";
      if (type === "speech_event") {
        // Speech events pace the reveal; without playback there is nothing to pace.
        if (playback) caption.handleControlMessage(payload);
        return;
      }
      if (type !== "assistant_delta" && type !== "assistant_done") return;
      const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
      if (!turnId) return;
      if (payload.spoken === true) {
        caption.handleControlMessage(payload);
        return;
      }
      handleTyped(type, payload, turnId);
    },
    dispose() {
      caption.dispose();
      typed.clear();
    },
  };
}
