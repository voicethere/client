const START_FALLBACK_MS = 400;
const DEFAULT_MS_PER_WORD = 330;

export type SpokenChatCaptionOptions = {
  enabled: boolean;
  onUpsert: (utteranceId: string, visibleText: string) => void;
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
  startTimeoutId?: ReturnType<typeof setTimeout>;
  tickTimeoutId?: ReturnType<typeof setTimeout>;
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
  let speakingActive = false;
  let utteranceCounter = 0;

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
    opts.onUpsert(state.utteranceId, visibleTextFor(state));
  };

  const scheduleNextWord = (utterance: UtteranceState): void => {
    if (
      utterance.frozen ||
      utterance.visibleWordCount >= utterance.words.length
    ) {
      return;
    }
    utterance.tickTimeoutId = setTimeoutFn(() => {
      if (!state || state !== utterance || utterance.frozen) return;
      utterance.visibleWordCount += 1;
      upsertCurrent();
      scheduleNextWord(utterance);
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
  };

  const shouldTypewriteChatReply = (
    payload: Record<string, unknown>,
  ): boolean => {
    if (!enabled) return false;
    if (payload.stream === true) return true;
    if (speakingActive) return true;
    return false;
  };

  const resetUtteranceState = (): void => {
    if (state) {
      clearUtteranceTimers(state);
      state = null;
    }
  };

  const handleChatReply = (payload: Record<string, unknown>): void => {
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

    if (!shouldTypewriteChatReply(payload)) {
      resetUtteranceState();
      opts.onUpsert(utteranceId, text);
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
    };

    state.startTimeoutId = setTimeoutFn(() => {
      if (state?.waitingForStart && !state.revealStarted) {
        startReveal(state);
      }
    }, START_FALLBACK_MS);

    if (speakingActive) {
      startReveal(state);
    }
  };

  const handleSpeechEvent = (payload: Record<string, unknown>): void => {
    const event = typeof payload.event === "string" ? payload.event : "";
    if (event === "agent_speaking_start") {
      speakingActive = true;
      if (state && (state.waitingForStart || !state.revealStarted)) {
        startReveal(state);
      }
      return;
    }
    if (event === "agent_speaking_end") {
      speakingActive = false;
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
      speakingActive = false;
      if (state) {
        clearUtteranceTimers(state);
        state.frozen = true;
        state.waitingForStart = false;
      }
    }
  };

  const handleControlMessage = (payload: Record<string, unknown>): void => {
    const type = typeof payload.type === "string" ? payload.type : "";
    if (type === "chat_reply") {
      handleChatReply(payload);
      return;
    }
    if (type === "speech_event") {
      if (enabled) {
        handleSpeechEvent(payload);
        return;
      }
    }

    const incoming = incomingAgentTextFromControlMessage(payload, {
      ignoreSpeechEventAgentText: enabled,
    });
    if (incoming) {
      resetUtteranceState();
      opts.onUpsert(newUtteranceId(), incoming);
    }
  };

  const dispose = (): void => {
    resetUtteranceState();
    speakingActive = false;
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
