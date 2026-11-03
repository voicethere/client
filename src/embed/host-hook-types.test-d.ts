import { describe, expectTypeOf, it } from "vitest";
import type {
  BrowserSession,
  DebugEvent,
  VoiceThereWidgetOptions,
  VoiceThereWidgetSessionEnd,
  VoiceThereWidgetStatus,
  WebRtcRuntime,
} from "./index.js";

describe("embed entry host hook types", () => {
  it("resolves the types a host needs to name", () => {
    expectTypeOf<
      NonNullable<VoiceThereWidgetOptions["onSession"]>
    >().parameters.toEqualTypeOf<[BrowserSession | null]>();
    expectTypeOf<
      NonNullable<VoiceThereWidgetOptions["onSessionEnd"]>
    >().parameters.toEqualTypeOf<[VoiceThereWidgetSessionEnd]>();
    expectTypeOf<
      NonNullable<VoiceThereWidgetOptions["onStatus"]>
    >().parameters.toEqualTypeOf<[VoiceThereWidgetStatus]>();
    expectTypeOf<
      NonNullable<VoiceThereWidgetOptions["isLinkAllowed"]>
    >().parameters.toEqualTypeOf<[URL]>();
    expectTypeOf<
      NonNullable<VoiceThereWidgetOptions["onDebugEvent"]>
    >().parameters.toEqualTypeOf<[DebugEvent]>();
    expectTypeOf<VoiceThereWidgetOptions["runtime"]>().toEqualTypeOf<
      WebRtcRuntime | undefined
    >();
  });
});
