/**
 * Rewrites an SDP answer so every Opus payload type asks the sender for stereo.
 *
 * RFC 7587: the receiver's own `stereo=1` (and `sprop-stereo=1`) in its fmtp tells the
 * sender it can use stereo. Without it Chrome decodes mono, so a server mix that pans
 * a source left or right collapses to the same signal on both ears.
 *
 * Other parameters keep their order and values. Existing `stereo` / `sprop-stereo`
 * values (including `0`) are replaced, never duplicated. SDP without Opus is returned
 * unchanged (the same string).
 *
 * Answers that already ask for stereo on every Opus payload type are returned unchanged.
 * Some WebRTC stacks (webrtc-rs) reject a local answer that differs from createAnswer's output.
 */
export function preferOpusStereoInAnswer(sdp: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const endsWithEol = sdp.endsWith(eol);
  const lines = sdp.split(eol);
  if (endsWithEol) lines.pop();

  const opusPts = new Set<string>();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\//i.exec(line);
    if (m) opusPts.add(m[1]);
  }
  if (opusPts.size === 0) return sdp;

  const stereoPts = new Set<string>();
  for (const line of lines) {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (m && opusPts.has(m[1]) && hasStereoOne(m[2])) stereoPts.add(m[1]);
  }
  if (stereoPts.size === opusPts.size) return sdp;

  const withFmtp = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (m && opusPts.has(m[1])) {
      withFmtp.add(m[1]);
      out.push(`a=fmtp:${m[1]} ${setStereoParams(m[2])}`);
    } else {
      out.push(line);
    }
  }

  const final: string[] = [];
  for (const line of out) {
    final.push(line);
    const m = /^a=rtpmap:(\d+) opus\//i.exec(line);
    if (m && !withFmtp.has(m[1])) {
      final.push(`a=fmtp:${m[1]} stereo=1;sprop-stereo=1`);
    }
  }
  return final.join(eol) + (endsWithEol ? eol : "");
}

function setStereoParams(params: string): string {
  const parts = params
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const key of ["stereo", "sprop-stereo"]) {
    const idx = parts.findIndex((p) => {
      const eq = p.indexOf("=");
      return (eq === -1 ? p : p.slice(0, eq)).toLowerCase() === key;
    });
    if (idx === -1) parts.push(`${key}=1`);
    else parts[idx] = `${key}=1`;
  }
  return parts.join(";");
}

function hasStereoOne(params: string): boolean {
  return params.split(";").some((p) => {
    const eq = p.indexOf("=");
    if (eq === -1) return false;
    return p.slice(0, eq).trim().toLowerCase() === "stereo" && p.slice(eq + 1).trim() === "1";
  });
}
