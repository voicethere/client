export enum ProvisionedRunnerModeType {
  Voice = "voice",
  Data = "data",
  VoiceAndData = "voice+data",
}

export type ProvisionedRunnerMode = `${ProvisionedRunnerModeType}`;

export enum BrowserSessionModeType {
  Voice = "voice",
  Chat = "chat",
  VoiceAndData = "voice+data",
}

export type BrowserSessionMode = `${BrowserSessionModeType}`;
