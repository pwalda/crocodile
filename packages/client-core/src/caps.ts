import type { HostCaps, NatType } from '@crocodile/protocol';

/**
 * Rough NAT classification from ICE gathering: compare the public mapping two
 * different STUN servers see. Same port → endpoint-independent mapping (cone,
 * good for hosting); different → symmetric (poor host). If our host candidate
 * already is the public address we are directly reachable ("open").
 */
export async function detectNat(
  RTCPeerConnectionImpl: typeof RTCPeerConnection,
  stunUrls: string[],
  timeoutMs = 4000,
): Promise<NatType> {
  const servers = [...new Set(stunUrls)].slice(0, 2);
  if (servers.length === 0) return 'unknown';
  const gather = async (url: string) => {
    const pc = new RTCPeerConnectionImpl({ iceServers: [{ urls: url }] });
    pc.createDataChannel('probe');
    const found: { host: string[]; srflx: { ip: string; port: number }[] } = {
      host: [],
      srflx: [],
    };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const parts = ev.candidate.candidate.split(' ');
        const ip = parts[4];
        const port = Number(parts[5]);
        const type = parts[7];
        if (!ip || parts[2]?.toLowerCase() !== 'udp') return;
        if (type === 'host') found.host.push(ip);
        if (type === 'srflx') found.srflx.push({ ip, port });
      };
      void pc.createOffer().then((o) => pc.setLocalDescription(o));
    });
    pc.close();
    return found;
  };
  const results = await Promise.all(servers.map(gather));
  const mapped = results.flatMap((r) => r.srflx);
  if (mapped.length === 0) return 'unknown';
  if (results.some((r) => r.srflx.some((s) => r.host.includes(s.ip)))) return 'open';
  if (results.length < 2 || results.some((r) => r.srflx.length === 0)) return 'unknown';
  const ports = new Set(mapped.map((m) => `${m.ip}:${m.port}`));
  return ports.size === 1 ? 'cone' : 'symmetric';
}

/** Browser-side capability hints for host election. */
export async function browserCapabilities(): Promise<Partial<HostCaps>> {
  const nav = globalThis.navigator as Navigator & {
    getBattery?: () => Promise<{ charging: boolean }>;
  };
  const caps: Partial<HostCaps> = {};
  if (nav?.hardwareConcurrency) caps.cpuCores = nav.hardwareConcurrency;
  try {
    const battery = await nav?.getBattery?.();
    if (battery) caps.onBattery = !battery.charging;
  } catch {
    /* not available */
  }
  return caps;
}
