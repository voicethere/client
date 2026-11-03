export type DebugEventLevel = "info" | "warn" | "error" | "debug";

export type DebugEvent = {
  level: DebugEventLevel;
  source: string;
  name: string;
  detail?: string;
  raw?: unknown;
  ts: string;
};

export type DebugEventSink = (event: DebugEvent) => void;

/** Number of events a debug console keeps. Older events are dropped. */
export const DEBUG_CONSOLE_MAX_EVENTS = 500;

/**
 * Keeps the newest 500 events (ring buffer, O(1) per event). The sink passed
 * as `onEvent` still receives every event.
 */
export function createDebugConsole(onEvent?: DebugEventSink) {
  const buffer: (DebugEvent | undefined)[] = new Array(
    DEBUG_CONSOLE_MAX_EVENTS,
  );
  let start = 0;
  let count = 0;

  const ordered = (): DebugEvent[] => {
    const out: DebugEvent[] = [];
    for (let i = 0; i < count; i++) {
      out.push(buffer[(start + i) % DEBUG_CONSOLE_MAX_EVENTS] as DebugEvent);
    }
    return out;
  };

  const emit = (partial: Omit<DebugEvent, "ts">) => {
    const event: DebugEvent = {
      ...partial,
      ts: new Date().toISOString(),
    };
    if (count < DEBUG_CONSOLE_MAX_EVENTS) {
      buffer[(start + count) % DEBUG_CONSOLE_MAX_EVENTS] = event;
      count++;
    } else {
      buffer[start] = event;
      start = (start + 1) % DEBUG_CONSOLE_MAX_EVENTS;
    }
    onEvent?.(event);
    return event;
  };

  return {
    events: () => ordered(),
    clear: () => {
      start = 0;
      count = 0;
      buffer.fill(undefined);
    },
    info: (source: string, name: string, detail?: string, raw?: unknown) =>
      emit({ level: "info", source, name, detail, raw }),
    warn: (source: string, name: string, detail?: string, raw?: unknown) =>
      emit({ level: "warn", source, name, detail, raw }),
    error: (source: string, name: string, detail?: string, raw?: unknown) =>
      emit({ level: "error", source, name, detail, raw }),
    debug: (source: string, name: string, detail?: string, raw?: unknown) =>
      emit({ level: "debug", source, name, detail, raw }),
    exportText: () =>
      ordered()
        .map((event) => {
          const detail = event.detail ? `: ${event.detail}` : "";
          return `${event.ts} [${event.level}] ${event.source}/${event.name}${detail}`;
        })
        .join("\n"),
  };
}

export type DebugConsole = ReturnType<typeof createDebugConsole>;
