/**
 * Voice is sent at a constant bitrate, so the size of a packet says nothing of what is spoken
 * (with variable bitrate, packet sizes follow the sounds, which can be read back from the
 * encrypted stream). The encoder follows what the other side's description asks for, so the host
 * could leave it out. This puts `cbr=1` into every Opus format of a description we are given.
 */
export function forceOpusCbr(sdp: string): string {
  const lines = sdp.split(/\r?\n/);
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const opus = new Set<string>();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000(?:\/|$)/i.exec(line);
    if (m) opus.add(m[1]!);
  }
  if (opus.size === 0) return sdp;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const fmtp = /^a=fmtp:(\d+) ?(.*)$/.exec(line);
    if (fmtp && opus.has(fmtp[1]!)) {
      seen.add(fmtp[1]!);
      const params = fmtp[2]!
        .split(';')
        .map((p) => p.trim())
        .filter((p) => p && !/^cbr=/i.test(p));
      out.push(`a=fmtp:${fmtp[1]} ${[...params, 'cbr=1'].join(';')}`);
      continue;
    }
    out.push(line);
    const rtpmap = /^a=rtpmap:(\d+) opus\/48000(?:\/|$)/i.exec(line);
    // A format with no parameters line gets one (placed after its rtpmap, where they belong).
    if (rtpmap && !lines.some((l) => l.startsWith(`a=fmtp:${rtpmap[1]} `)))
      out.push(`a=fmtp:${rtpmap[1]} cbr=1`);
  }
  return out.join(eol);
}
