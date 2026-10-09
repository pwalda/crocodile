import { describe, expect, it } from 'vitest';
import {
  createNetworkProber,
  networkVerdict,
  probeNetwork,
  routeFromStats,
} from '@crocodile/client-core';

/** A stand-in RTCPeerConnection: per STUN URL, the reflexive candidates it finds, or no answer. */
function fakePeerConnection(byUrl: Record<string, string[] | 'no answer'>) {
  return class {
    onicecandidate: ((ev: { candidate: { candidate: string } | null }) => void) | null = null;
    onicecandidateerror: (() => void) | null = null;
    private url: string;
    constructor(config: { iceServers: { urls: string }[] }) {
      this.url = config.iceServers[0]!.urls;
    }
    createDataChannel() {}
    async createOffer() {
      return {};
    }
    async setLocalDescription() {
      const found = byUrl[this.url] ?? [];
      this.onicecandidate?.({ candidate: { candidate: host('10.0.0.2') } });
      if (found === 'no answer') this.onicecandidateerror?.();
      else for (const c of found) this.onicecandidate?.({ candidate: { candidate: c } });
      this.onicecandidate?.({ candidate: null });
    }
    close() {}
  } as unknown as typeof RTCPeerConnection;
}

const host = (ip: string, port = 50000) => `candidate:1 1 udp 2122260223 ${ip} ${port} typ host`;
const srflx = (ip: string, port: number) =>
  `candidate:2 1 udp 1686052607 ${ip} ${port} typ srflx raddr 0.0.0.0 rport 0`;
const STUN = ['stun:coord.example:7443', 'stun:coord.example:7444'];

async function check(a: string[] | 'no answer', b: string[] | 'no answer') {
  const probe = await probeNetwork(fakePeerConnection({ [STUN[0]!]: a, [STUN[1]!]: b }), STUN);
  return { probe, verdict: networkVerdict(probe) };
}

describe('network check', () => {
  it('tells a good network from a limited or blocked one', async () => {
    // Both STUN ports see the same public mapping: a cone NAT, fine for direct connections.
    expect(await check([srflx('203.0.113.9', 40001)], [srflx('203.0.113.9', 40001)])).toEqual({
      probe: { nat: 'cone', udp: true },
      verdict: 'good',
    });
    // A new mapping per destination: symmetric NAT, direct connections often fail.
    expect(await check([srflx('203.0.113.9', 40001)], [srflx('203.0.113.9', 40777)])).toEqual({
      probe: { nat: 'symmetric', udp: true },
      verdict: 'limited',
    });
    // No STUN answer at all: UDP is blocked, nothing direct can work.
    expect(await check('no answer', 'no answer')).toEqual({
      probe: { nat: 'unknown', udp: false },
      verdict: 'blocked',
    });
    // Both answered with our own address, which WebRTC drops as a duplicate:
    // nothing in between, as with a server on the same network.
    expect(await check([], [])).toEqual({ probe: { nat: 'open', udp: true }, verdict: 'good' });
    // The public address is the machine's own.
    expect((await check([srflx('10.0.0.2', 50000)], [])).verdict).toBe('good');
    // Only one port answered: can't tell.
    expect((await check([srflx('203.0.113.9', 1)], 'no answer')).verdict).toBe('unknown');
  });

  it('tests again when the app moves to another server, and reuses a recent result otherwise', async () => {
    let gathered = 0;
    const PC = fakePeerConnection({
      'stun:a.example:7443': [srflx('203.0.113.9', 1)],
      'stun:a.example:7444': [srflx('203.0.113.9', 1)],
      'stun:b.example:7443': [srflx('203.0.113.9', 1)],
      'stun:b.example:7444': [srflx('203.0.113.9', 2)],
    });
    const Counting = class extends (PC as unknown as new (c: unknown) => object) {
      constructor(c: unknown) {
        super(c);
        gathered++;
      }
    } as unknown as typeof RTCPeerConnection;
    let server = 'a';
    const probe = createNetworkProber(Counting, () => [
      `stun:${server}.example:7443`,
      `stun:${server}.example:7444`,
    ]);
    expect(networkVerdict(await probe())).toBe('good');
    expect(networkVerdict(await probe())).toBe('good');
    expect(gathered).toBe(2);
    server = 'b';
    expect(networkVerdict(await probe())).toBe('limited');
    expect(gathered).toBe(4);
    await probe(true);
    expect(gathered).toBe(6);
  });

  it('reads how a connection travels from WebRTC stats', () => {
    const stats = (local: string, remote: string, remoteAddress = '203.0.113.9') =>
      new Map<string, Record<string, unknown>>([
        ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
        ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' }],
        ['L', { id: 'L', type: 'local-candidate', candidateType: local, address: '192.168.1.5' }],
        ['R', { id: 'R', type: 'remote-candidate', candidateType: remote, address: remoteAddress }],
      ]) as unknown as RTCStatsReport;
    expect(routeFromStats(stats('host', 'host', '192.168.1.7'))).toBe('lan');
    expect(routeFromStats(stats('host', 'host', '127.0.0.1'))).toBe('local');
    expect(routeFromStats(stats('host', 'host', '127.0.0.2'))).toBe('local');
    // Found during connectivity checks: still the same network.
    expect(routeFromStats(stats('host', 'prflx', '10.0.0.8'))).toBe('lan');
    expect(routeFromStats(stats('host', 'host', 'b1c2d3e4.local'))).toBe('lan');
    expect(routeFromStats(stats('host', 'host', 'fd00::5'))).toBe('lan');
    expect(routeFromStats(stats('srflx', 'srflx'))).toBe('internet');
    // Same address at both ends.
    expect(routeFromStats(stats('host', 'prflx', '192.168.1.5'))).toBe('local');
    expect(routeFromStats(stats('prflx', 'host', '2001:db8::7'))).toBe('internet');
    expect(routeFromStats(stats('relay', 'host'))).toBe('relay');
    expect(routeFromStats(new Map() as unknown as RTCStatsReport)).toBeNull();
    // A peer-reflexive address the browser hides: not known yet.
    expect(routeFromStats(stats('host', 'prflx', ''))).toBeNull();
  });
});
