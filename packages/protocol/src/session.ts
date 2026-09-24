import { z } from 'zod';

/**
 * A session is a live P2P group: a space's text mesh, a voice channel, or a DM.
 * The coordination server elects a host (and a backup) among its members; all
 * members connect to the host's relay. Session ids encode their scope:
 *
 *   space:<spaceId>                 text + presence for a whole space
 *   voice:<spaceId>:<channelId>     one voice channel
 *   dm:<userIdA>:<userIdB>          direct conversation (ids sorted)
 */
export type SessionScope =
  | { kind: 'space'; spaceId: string }
  | { kind: 'voice'; spaceId: string; channelId: string }
  | { kind: 'dm'; users: [string, string] };

const idPart = '[a-z2-7]{8,64}';
const SESSION_RE = new RegExp(`^(?:space:${idPart}|voice:${idPart}:${idPart}|dm:${idPart}:${idPart})$`);

export const SessionId = z.string().regex(SESSION_RE);

export function parseSessionId(id: string): SessionScope | null {
  if (!SESSION_RE.test(id)) return null;
  const [kind, a, b] = id.split(':') as [string, string, string | undefined];
  if (kind === 'space') return { kind: 'space', spaceId: a };
  if (kind === 'voice') return { kind: 'voice', spaceId: a, channelId: b! };
  if (kind === 'dm') {
    if (!(a < b!)) return null;
    return { kind: 'dm', users: [a, b!] };
  }
  return null;
}

export const sessionIds = {
  space: (spaceId: string) => `space:${spaceId}`,
  voice: (spaceId: string, channelId: string) => `voice:${spaceId}:${channelId}`,
  dm: (a: string, b: string) => (a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`),
};

export const NatType = z.enum(['open', 'cone', 'symmetric', 'unknown']);
export type NatType = z.infer<typeof NatType>;

export const Platform = z.enum(['desktop', 'web', 'mobile', 'bot']);
export type Platform = z.infer<typeof Platform>;

/** What a member reports about its ability to act as the session host. */
export const HostCaps = z.object({
  /** Platform can run a relay and the user allows hosting. */
  canHost: z.boolean(),
  platform: Platform,
  nat: NatType,
  /** Measured or configured upload bandwidth. */
  uplinkKbps: z.number().int().min(0).max(10_000_000).optional(),
  cpuCores: z.number().int().min(0).max(1024).optional(),
  onBattery: z.boolean().optional(),
  /** Round-trip to the coordination server in ms. */
  rttMs: z.number().min(0).max(60_000).optional(),
});
export type HostCaps = z.infer<typeof HostCaps>;

export interface SessionMember {
  userId: string;
  joinedAt: number;
  caps: HostCaps;
}

export interface SessionState {
  id: string;
  /** Increments every time the host changes; stale signals are ignored. */
  epoch: number;
  host: string | null;
  backup: string | null;
  members: SessionMember[];
  relaySlots: number;
  updatedAt: number;
}

export interface VoiceOccupancy {
  spaceId: string;
  channelId: string;
  members: string[];
  host: string | null;
}
