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
