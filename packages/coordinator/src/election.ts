import type { SessionMember } from '@crocodile/protocol';

/**
 * Host election. The host runs the session's relay, so we want the member
 * most likely to be reachable by everyone with bandwidth to spare: an open or
 * cone NAT, a desktop on mains power, fast uplink, low latency. A little
 * tenure bonus plus "keep the current host while it is healthy" avoid
 * flapping when a slightly better peer joins.
 *
 * What a member says about its machine cannot be checked, so what it can gain by
 * saying more is capped: the best score a claim can reach is one an honest desktop
 * with a good connection reaches too (uplink counts up to a fixed share, cores and
 * round-trip time not at all). Ties go by a hash of the session and the device, so
 * they do not always favour the name that sorts first (a device id is still its own to
 * pick, so this is no protection against one that tries many). Each person is one candidate (their best
 * device), so having many devices gives no more chances, and a backup is a different
 * person where there is one.
 *
 * One exception to keeping the host: a host behind a symmetric NAT gives way
 * to the best member whose NAT isn't symmetric (open, cone, or not fully
 * tested). Whoever starts a call or opens a channel first is elected while
 * alone, and members on other networks often can't reach a symmetric-NAT
 * host at all, while it can always reach them.
 */
const NAT_SCORE = { open: 40, cone: 25, unknown: 10, symmetric: 0 } as const;
/** The most uplink can add: reached at about 1.5 Mbps, so nobody gains by claiming more. */
const UPLINK_SCORE_MAX = 20;

export function isHostEligible(m: SessionMember): boolean {
  return m.caps.canHost && (m.caps.platform === 'desktop' || m.caps.platform === 'bot');
}

export function hostScore(m: SessionMember, now: number): number {
  if (!isHostEligible(m)) return Number.NEGATIVE_INFINITY;
  const c = m.caps;
  let score = NAT_SCORE[c.nat];
  if (c.uplinkKbps !== undefined)
    score += Math.min(UPLINK_SCORE_MAX, Math.log2(1 + c.uplinkKbps / 500) * 10);
  else score += 10;
  if (c.onBattery) score -= 15;
  score += Math.min(5, (now - m.joinedAt) / 60_000);
  return score;
}

export interface ElectionInput {
  sessionId: string;
  members: SessionMember[];
  host: string | null;
  backup: string | null;
  /** peer id -> epoch ms until which the member may not host (failed as host recently). */
  penalties: Map<string, number>;
  now: number;
}

export function elect({ sessionId, members, host, backup, penalties, now }: ElectionInput): {
  host: string | null;
  backup: string | null;
} {
  const available = (m: SessionMember) => isHostEligible(m) && (penalties.get(m.peer) ?? 0) <= now;
  const byId = new Map(members.map((m) => [m.peer, m]));
  // Best first; ties by a hash of the session and the device.
  const better = (a: SessionMember, b: SessionMember) =>
    hostScore(b, now) - hostScore(a, now) ||
    fnv1a(`${sessionId}|${b.peer}`) - fnv1a(`${sessionId}|${a.peer}`) ||
    a.peer.localeCompare(b.peer);
  // A network that others can reach, or one that could not be checked, beats a known symmetric one.
  const reachable = (m: SessionMember) => m.caps.nat !== 'symmetric';
  // One candidate a person: their best device, one others can reach if they have one.
  const onePerPerson = (list: SessionMember[]) => {
    const best = new Map<string, SessionMember>();
    for (const m of [...list].sort(better)) {
      const have = best.get(m.userId);
      if (!have || (!reachable(have) && reachable(m))) best.set(m.userId, m);
    }
    return [...best.values()].sort(better);
  };
  const ranked = onePerPerson(members.filter(available));

  let nextHost: string | null = null;
  const current = host ? byId.get(host) : undefined;
  // A network check that couldn't finish ('unknown') is still a better bet
  // than a known symmetric NAT (a device with UDP blocked reports symmetric).
  const betterReachable =
    current?.caps.nat === 'symmetric' ? ranked.find((m) => reachable(m)) : undefined;
  if (betterReachable) nextHost = betterReachable.peer;
  else if (current && available(current)) nextHost = current.peer;
  else {
    const standby = backup ? byId.get(backup) : undefined;
    if (standby && available(standby)) nextHost = standby.peer;
    else nextHost = ranked[0]?.peer ?? null;
  }
  // A penalty means "prefer someone else". With nobody else, keep (or take)
  // a penalised host: members who can't reach it directly may still get
  // through the relay, and nobody can without a host.
  if (!nextHost) {
    if (current && isHostEligible(current)) nextHost = current.peer;
    else nextHost = onePerPerson(members.filter(isHostEligible))[0]?.peer ?? null;
  }

  // Keep the backup stable unless a clearly better candidate appears.
  // (Another person where there is one: a person's other device is no stand-in for them.)
  const hostUser = nextHost ? byId.get(nextHost)?.userId : undefined;
  const others = ranked.filter((m) => m.peer !== nextHost);
  const candidates = others.some((m) => m.userId !== hostUser)
    ? others.filter((m) => m.userId !== hostUser)
    : others;
  let nextBackup: string | null = candidates[0]?.peer ?? null;
  const currentBackup = backup && backup !== nextHost ? byId.get(backup) : undefined;
  // (Only one of the candidates: not the host's other device, nor a person who is out.)
  // Nor a device behind a symmetric NAT when the person has one that can be reached.
  const standIn = currentBackup && candidates.find((m) => m.userId === currentBackup.userId);
  if (
    currentBackup &&
    available(currentBackup) &&
    candidates[0] &&
    standIn &&
    (reachable(currentBackup) || !reachable(standIn))
  ) {
    if (hostScore(candidates[0], now) - hostScore(currentBackup, now) < 10)
      nextBackup = currentBackup.peer;
  }
  return { host: nextHost, backup: nextBackup };
}

/** Rendezvous (highest random weight) hashing: every server computes the same owner. */
export function rendezvousOwner(sessionId: string, serverIds: string[]): string {
  let best = '';
  let bestWeight = -1;
  for (const id of serverIds) {
    const w = fnv1a(`${id}|${sessionId}`);
    if (w > bestWeight || (w === bestWeight && id < best)) {
      best = id;
      bestWeight = w;
    }
  }
  return best;
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Final avalanche (murmur3 fmix32) so similar inputs spread well.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
