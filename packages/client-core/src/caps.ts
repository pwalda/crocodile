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
  return (await probeNetwork(RTCPeerConnectionImpl, stunUrls, timeoutMs)).nat;
}

/**
 * What the network allows, from the coordination server's two STUN ports:
 * `udp` is false when neither answered (UDP blocked, so no direct
 * connections at all), `nat` is the mapping type as in detectNat.
 */
export interface NetworkProbe {
  nat: NatType;
  udp: boolean;
}

export async function probeNetwork(
  RTCPeerConnectionImpl: typeof RTCPeerConnection,
  stunUrls: string[],
  timeoutMs = 8000,
): Promise<NetworkProbe> {
  const servers = [...new Set(stunUrls)].slice(0, 2);
  if (servers.length === 0) return { nat: 'unknown', udp: true };
  const gather = async (url: string) => {
    const pc = new RTCPeerConnectionImpl({ iceServers: [{ urls: url }] });
    pc.createDataChannel('probe');
    const found = {
      host: [] as string[],
      srflx: [] as { ip: string; port: number }[],
      /** The STUN server didn't answer (or couldn't be reached). */
      errored: false,
      /** Gathering finished before the timeout. */
      complete: false,
    };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicecandidateerror = () => {
        found.errored = true;
      };
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          found.complete = true;
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
  if (mapped.length === 0) {
    // No server saw us from outside. Either nothing answered (UDP blocked) or
    // every answer matched a local address, which WebRTC drops as a duplicate:
    // nothing translates our address on the way to the server.
    if (results.every((r) => r.errored)) return { nat: 'unknown', udp: false };
    if (results.every((r) => r.complete && !r.errored)) return { nat: 'open', udp: true };
    return { nat: 'unknown', udp: true };
  }
  if (results.some((r) => r.srflx.some((s) => r.host.includes(s.ip))))
    return { nat: 'open', udp: true };
  if (results.length < 2 || results.some((r) => r.srflx.length === 0))
    return { nat: 'unknown', udp: true };
  const ports = new Set(mapped.map((m) => `${m.ip}:${m.port}`));
  return { nat: ports.size === 1 ? 'cone' : 'symmetric', udp: true };
}

/** How well direct connections can work from here. */
export type NetworkVerdict = 'good' | 'limited' | 'blocked' | 'unknown';

export function networkVerdict(probe: NetworkProbe): NetworkVerdict {
  if (!probe.udp) return 'blocked';
  if (probe.nat === 'open' || probe.nat === 'cone') return 'good';
  if (probe.nat === 'symmetric') return 'limited';
  return 'unknown';
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
