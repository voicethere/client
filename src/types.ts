export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

/** Credentials from platform POST /api/v1/sessions (cloud mode). */
export type CloudSessionCredentials = {
  sessionId: string;
  joinToken: string;
  signalingUrl: string;
  roomId: string;
  iceServers?: IceServerConfig[];
  expiresAt?: string;
};

/** Direct runner signaling (M1 local dev). */
export type LocalSessionOptions = {
  mode: "local";
  signalingUrl: string;
  sessionId: string;
  peerId?: string;
};

/** Gateway join via orchestrator-minted JWT (M4). */
export type CloudSessionOptions = {
  mode: "cloud";
  credentials: CloudSessionCredentials;
  peerId?: string;
};

export type VoiceThereClientOptions = LocalSessionOptions | CloudSessionOptions;

export type ConnectedClient = {
  peerId: string;
  roomId: string;
  signalingUrl: string;
  disconnect: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type AgentStateName =
  "listening" | "thinking" | "tool_call" | "speaking";

/** What the agent is doing, sent by agents that call `setAgentState` in `@voicethere/agent`. */
export interface AgentStateEvent {
  state: AgentStateName;
  detail?: string;
}

/**
 * Structured content an agent sends next to its reply text (`assistant_content`).
 * Only `link` exists today; messages with other kinds are ignored.
 */
export type AgentContent = { kind: "link"; url: string; label?: string };

/** One `assistant_content` message, paired with its reply by `turnId`. */
export interface AgentContentEvent {
  turnId: string;
  /** Caller utterance the reply answers (voice turns, when the runner sends one). */
  inReplyTo?: string;
  /** True for content of a spoken (voice) reply. */
  spoken: boolean;
  content: AgentContent;
}

/**
 * One `assistant_filler` message: a short phrase the agent spoke while it worked ("one moment").
 * It is not part of the reply text, so it is never reported through `onAgentText`.
 */
export interface AgentFillerEvent {
  turnId: string;
  text: string;
}

/** The caller cut the agent off; `replyPlayedMs` is how much of the reply was heard. */
export interface AgentInterruptedEvent {
  turnId?: string;
  replyPlayedMs: number;
  playedTextExact: boolean;
}
