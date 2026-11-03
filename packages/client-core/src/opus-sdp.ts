/**
 * Voice is sent at a constant bitrate, so the size of a packet says nothing of what is spoken
 * (with variable bitrate, packet sizes follow the sounds, which can be read back from the
 * encrypted stream). The encoder follows what the other side's description asks for, so the host
 * could leave it out. This puts `cbr=1` into every Opus format of a description we are given.
 */
export function forceOpusCbr(sdp: string): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const out: string[] = [];
  // Payload numbers belong to one media section (`m=`), so each is dealt with on its own.
  let start = 0;
  for (let i = 1; i <= lines.length; i++) {
    if (i < lines.length && !lines[i]!.startsWith('m=')) continue;
    out.push(...forceInSection(lines.slice(start, i)));
    start = i;
  }
  return out.join(eol);
}

const RTPMAP = /^a=rtpmap:(\d+) opus\/48000(?:\/|$)/i;
const FMTP = /^a=fmtp:(\d+)(?: (.*))?$/;

function forceInSection(lines: string[]): string[] {
  const opus = new Set<string>();
  for (const line of lines) {
    const m = RTPMAP.exec(line);
    if (m) opus.add(m[1]!);
  }
  if (opus.size === 0) return lines;
  const given = new Set<string>();
  for (const line of lines) {
    const m = FMTP.exec(line);
    if (m && opus.has(m[1]!)) given.add(m[1]!);
  }
  const out: string[] = [];
  for (const line of lines) {
    const fmtp = FMTP.exec(line);
    if (fmtp && opus.has(fmtp[1]!)) {
      const params = (fmtp[2] ?? '')
        .split(';')
        .map((p) => p.trim())
        .filter((p) => p && !/^cbr=/i.test(p));
      out.push(`a=fmtp:${fmtp[1]} ${[...params, 'cbr=1'].join(';')}`);
      continue;
    }
    out.push(line);
    // A format with no parameters line gets one, after its rtpmap.
    const rtpmap = RTPMAP.exec(line);
    if (rtpmap && !given.has(rtpmap[1]!)) out.push(`a=fmtp:${rtpmap[1]} cbr=1`);
  }
  return out;
}
