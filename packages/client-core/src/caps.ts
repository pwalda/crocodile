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
  // One connection asks both STUN ports from the same local sockets, so their
  // answers are comparable: behind a cone NAT both see the same mapping
  // (which WebRTC reports once), behind a symmetric NAT each sees its own.
  const pc = new RTCPeerConnectionImpl({ iceServers: servers.map((urls) => ({ urls })) });
  pc.createDataChannel('probe');
  /** Local sockets ("ip:port") and the public mappings the servers saw. */
  const hosts = new Set<string>();
  const hostIps = new Set<string>();
  const mapped = new Set<string>();
  const mappedIps = new Set<string>();
  /** Local sockets whose STUN request failed; `unattributed` if one didn't say. */
  const failed = new Set<string>();
  let unattributed = false;
  let complete = false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.onicecandidateerror = (ev) => {
      const e = ev as RTCPeerConnectionIceErrorEvent;
      if (e.address && e.port) failed.add(`${e.address}:${e.port}`);
      else unattributed = true;
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) {
        complete = true;
        clearTimeout(timer);
        resolve();
        return;
      }
      const parts = ev.candidate.candidate.split(' ');
      const ip = parts[4];
      const port = parts[5];
      const type = parts[7];
      if (!ip || parts[2]?.toLowerCase() !== 'udp') return;
      if (type === 'host') {
        hosts.add(`${ip}:${port}`);
        hostIps.add(ip);
      }
      if (type === 'srflx') {
        mapped.add(`${ip}:${port}`);
        mappedIps.add(ip);
      }
    };
    void pc.createOffer().then((o) => pc.setLocalDescription(o));
  });
  pc.close();
  if (mapped.size === 0) {
    // Nobody saw us from outside. Either no request got an answer (UDP
    // blocked), or every answer matched a local address, which WebRTC drops
    // as a duplicate: nothing translates our address on the way to the server.
    if (!complete) return { nat: 'unknown', udp: true };
    if (failed.size === 0 && !unattributed) return { nat: 'open', udp: true };
    // Blocked only if the requests failed on every local socket: one failing
    // interface (say IPv6) next to a working one says nothing.
    const everySocketFailed =
      !unattributed && hosts.size > 0 && [...hosts].every((h) => failed.has(h));
    return everySocketFailed ? { nat: 'unknown', udp: false } : { nat: 'unknown', udp: true };
  }
  if ([...mappedIps].some((ip) => hostIps.has(ip))) return { nat: 'open', udp: true };
  if (servers.length < 2) return { nat: 'unknown', udp: true };
  // More public mappings than local sockets: the NAT maps each destination
  // separately.
  return { nat: mapped.size > Math.max(1, hosts.size) ? 'symmetric' : 'cone', udp: true };
}

/**
 * probeNetwork with a cache: one probe serves the network check and host
 * election for `ttlMs`, as long as the STUN servers (the coordination server
 * we're on) stay the same.
 */
export function createNetworkProber(
  RTCPeerConnectionImpl: typeof RTCPeerConnection,
  stunUrls: () => string[],
  ttlMs = 10 * 60_000,
) {
  let cache: { at: number; servers: string; probe: Promise<NetworkProbe> } | undefined;
  return (fresh = false): Promise<NetworkProbe> => {
    const urls = stunUrls();
    const servers = urls.join(' ');
    if (fresh || !cache || cache.servers !== servers || Date.now() - cache.at > ttlMs) {
      cache = {
        at: Date.now(),
        servers,
        probe: probeNetwork(RTCPeerConnectionImpl, urls).catch((): NetworkProbe => ({
          nat: 'unknown',
          udp: true,
        })),
      };
    }
    return cache.probe;
  };
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
