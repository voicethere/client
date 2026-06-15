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

export function createDebugConsole(onEvent?: DebugEventSink) {
  const events: DebugEvent[] = [];

  const emit = (partial: Omit<DebugEvent, "ts">) => {
    const event: DebugEvent = {
      ...partial,
      ts: new Date().toISOString(),
    };
    events.push(event);
    onEvent?.(event);
    return event;
  };

  return {
    events: () => [...events],
    clear: () => {
      events.length = 0;
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
      events
        .map((event) => {
          const detail = event.detail ? `: ${event.detail}` : "";
          return `${event.ts} [${event.level}] ${event.source}/${event.name}${detail}`;
        })
        .join("\n"),
  };
}

export type DebugConsole = ReturnType<typeof createDebugConsole>;
