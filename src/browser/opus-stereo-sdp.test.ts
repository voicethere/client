import { describe, expect, it } from "vitest";

import { preferOpusStereoInAnswer } from "./opus-stereo-sdp.js";

const audioSection = (pt: string, fmtp: string | null): string[] => [
  "m=audio 9 UDP/TLS/RTP/SAVPF " + pt,
  `a=rtpmap:${pt} opus/48000/2`,
  ...(fmtp === null ? [] : [`a=fmtp:${pt} ${fmtp}`]),
];

const sdpOf = (lines: string[], eol = "\r\n"): string => lines.join(eol) + eol;

describe("preferOpusStereoInAnswer", () => {
  it("Chrome default answer gains stereo", () => {
    const out = preferOpusStereoInAnswer(
      sdpOf(["v=0", ...audioSection("111", "minptime=10;useinbandfec=1")]),
    );
    expect(out).toContain(
      "a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1\r\n",
    );
  });

  it("stereo=0 is replaced", () => {
    const out = preferOpusStereoInAnswer(
      sdpOf(["v=0", ...audioSection("111", "minptime=10;stereo=0;useinbandfec=1")]),
    );
    expect(out).toContain("a=fmtp:111 minptime=10;stereo=1;useinbandfec=1;sprop-stereo=1");
    expect(out.match(/stereo=/g)?.length).toBe(2);
    expect(out).not.toContain("stereo=0");
  });

  it("already stereo=1 is not duplicated", () => {
    const input = sdpOf(["v=0", ...audioSection("111", "stereo=1;sprop-stereo=1")]);
    const out = preferOpusStereoInAnswer(input);
    expect(out).toBe(input);
    expect(out.match(/(?<![-\w])stereo=1/g)?.length).toBe(1);
    expect(out.match(/sprop-stereo=1/g)?.length).toBe(1);
  });

  it("every Opus payload type is rewritten", () => {
    const out = preferOpusStereoInAnswer(
      sdpOf([
        "v=0",
        ...audioSection("111", "minptime=10"),
        ...audioSection("109", "useinbandfec=1"),
      ]),
    );
    expect(out).toContain("a=fmtp:111 minptime=10;stereo=1;sprop-stereo=1");
    expect(out).toContain("a=fmtp:109 useinbandfec=1;stereo=1;sprop-stereo=1");
  });

  it("non-Opus fmtp untouched", () => {
    const out = preferOpusStereoInAnswer(
      sdpOf([
        "v=0",
        ...audioSection("111", "minptime=10"),
        "a=rtpmap:126 telephone-event/8000",
        "a=fmtp:126 0-15",
      ]),
    );
    expect(out).toContain("a=fmtp:126 0-15\r\n");
    expect(out).not.toContain("a=fmtp:126 0-15;");
  });

  it("CRLF preserved", () => {
    const out = preferOpusStereoInAnswer(sdpOf(["v=0", ...audioSection("111", "minptime=10")]));
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(out.endsWith("\r\n")).toBe(true);
  });

  it("no Opus returns the same string", () => {
    const input = sdpOf(["v=0", "m=audio 9 RTP/SAVPF 0", "a=rtpmap:0 PCMU/8000"]);
    expect(preferOpusStereoInAnswer(input)).toBe(input);
  });

  it("Opus without fmtp gets one inserted after its rtpmap", () => {
    const out = preferOpusStereoInAnswer(sdpOf(["v=0", ...audioSection("111", null), "a=mid:0"]));
    expect(out).toContain(
      "a=rtpmap:111 opus/48000/2\r\na=fmtp:111 stereo=1;sprop-stereo=1\r\na=mid:0\r\n",
    );
  });
});
