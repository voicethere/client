import { describe, expect, it } from "vitest";

import { appendJoinToken, resolveConnection } from "../src/resolve-connection.js";

describe("resolveConnection", () => {
  it("local mode uses sessionId as room", () => {
    expect(
      resolveConnection({
        mode: "local",
        signalingUrl: "ws://127.0.0.1:8080/ws",
        sessionId: "room-a",
      }),
    ).toEqual({
      signalingUrl: "ws://127.0.0.1:8080/ws",
      roomId: "room-a",
      peerId: undefined,
    });
  });

  it("cloud mode appends join token to signaling URL", () => {
    const resolved = resolveConnection({
      mode: "cloud",
      credentials: {
        sessionId: "sess",
        joinToken: "jwt-token",
        signalingUrl: "ws://127.0.0.1:8082/ws",
        roomId: "room-b",
      },
    });
    expect(resolved.roomId).toBe("room-b");
    expect(resolved.signalingUrl).toContain("token=jwt-token");
  });
});

describe("appendJoinToken", () => {
  it("does not duplicate token param", () => {
    const url = appendJoinToken("ws://host/ws?token=existing", "new");
    expect(url).toContain("token=existing");
    expect(url).not.toContain("token=new");
  });
});
