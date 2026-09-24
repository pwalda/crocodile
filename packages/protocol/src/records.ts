import { z } from 'zod';
import { LIMITS } from './constants';

/**
 * Replicated metadata. Every record is signed by its author's identity key so
 * any coordination server in the mesh can store, serve and forward it without
 * being trusted: clients and servers both verify signatures and authority.
 *
 * Voice and text content are never records.
 */
export const RECORD_KINDS = ['profile', 'device', 'friends', 'space', 'invite', 'member'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

const id = z.string().regex(/^[a-z2-7]{8,64}$/);
const pubKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const DeviceId = z.string().regex(/^[a-z2-7]{8,32}$/);

/**
 * A device's current one-time-ish prekey: an X25519 key plus an ML-KEM-768
 * key (post-quantum). Sender keys are sealed to both (hybrid), and devices
 * rotate prekeys weekly and delete the old secrets, giving forward secrecy.
 */
export const PrekeyBundle = z.object({
  id: z.number().int().min(0).max(0xffffffff),
  x25519: pubKey,
  /** ML-KEM-768 encapsulation key, base64url (1184 bytes). */
  mlkem: z.string().regex(/^[A-Za-z0-9_-]{1579}$/),
  expiresAt: z.number().int(),
});
export type PrekeyBundle = z.infer<typeof PrekeyBundle>;

export const DeviceBody = z.object({
  userId: id,
  deviceId: DeviceId,
  /** Human-readable, e.g. "Desktop · Windows". */
  name: z.string().trim().min(1).max(64),
  platform: z.enum(['desktop', 'web', 'mobile', 'bot']),
  prekey: PrekeyBundle,
  /** Revocation is permanent: later versions of a revoked device are refused. */
  revoked: z.boolean().optional(),
});
export type DeviceBody = z.infer<typeof DeviceBody>;

export const ProfileBody = z.object({
  username: z.string().trim().min(1).max(LIMITS.usernameMax),
  /** X25519 public key used to seal sender keys and pairwise messages to this user. */
  encKey: pubKey,
  avatar: z
    .string()
    .max(Math.ceil(LIMITS.avatarMaxBytes * 1.4))
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,/)
    .optional(),
  bio: z.string().max(LIMITS.bioMax).optional(),
  /** Accent colour for the profile banner, #rrggbb. */
  accent: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
});
export type ProfileBody = z.infer<typeof ProfileBody>;

/**
 * A user's own relationship list. A friendship exists when both users list
 * each other; listing someone who does not list you back is a pending request.
 */
export const FriendsBody = z.object({
  friends: z.array(id).max(LIMITS.friendsMax),
  blocked: z.array(id).max(LIMITS.friendsMax),
});
export type FriendsBody = z.infer<typeof FriendsBody>;

export const ChannelKind = z.enum(['text', 'voice']);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const Channel = z.object({
  id,
  name: z.string().trim().min(1).max(LIMITS.channelNameMax),
  kind: ChannelKind,
  topic: z.string().max(1024).optional(),
});
export type Channel = z.infer<typeof Channel>;

export const SpaceBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.spaceNameMax),
  icon: z
    .string()
    .max(Math.ceil(LIMITS.avatarMaxBytes * 1.4))
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,/)
    .optional(),
  /** userId of the owner. spaceId = hash(owner key, nonce), so it cannot change. */
  owner: id,
  nonce: z.string().min(8).max(64),
  admins: z.array(id).max(100),
  bans: z.array(id).max(10_000),
  channels: z.array(Channel).max(LIMITS.channelsPerSpace),
  deleted: z.boolean().optional(),
});
export type SpaceBody = z.infer<typeof SpaceBody>;

export const InviteBody = z.object({
  spaceId: id,
  code: z.string().regex(/^[a-z2-7]{8,16}$/),
  /** Epoch ms, or null for never. */
  expiresAt: z.number().int().nullable(),
  revoked: z.boolean().optional(),
});
export type InviteBody = z.infer<typeof InviteBody>;

export const MemberBody = z.object({
  spaceId: id,
  userId: id,
  /** Invite used to join; the space owner and admins may omit it. */
  inviteCode: z.string().optional(),
  left: z.boolean().optional(),
});
export type MemberBody = z.infer<typeof MemberBody>;

export interface RecordBodies {
  profile: ProfileBody;
  device: DeviceBody;
  friends: FriendsBody;
  space: SpaceBody;
  invite: InviteBody;
  member: MemberBody;
}

export const RECORD_BODY_SCHEMAS = {
  profile: ProfileBody,
  device: DeviceBody,
  friends: FriendsBody,
  space: SpaceBody,
  invite: InviteBody,
  member: MemberBody,
} as const satisfies Record<RecordKind, z.ZodType>;

export interface SignedRecord<K extends RecordKind = RecordKind> {
  v: 1;
  kind: K;
  /** `${kind}:${...}`; see recordKey helpers. */
  key: string;
  /** Ed25519 public key of the signer, base64url. */
  author: string;
  /** Epoch ms. Last writer wins; must strictly increase for a key. */
  version: number;
  body: RecordBodies[K];
  sig: string;
}

export const SignedRecordEnvelope = z.object({
  v: z.literal(1),
  kind: z.enum(RECORD_KINDS),
  key: z.string().min(3).max(200),
  author: pubKey,
  version: z.number().int().positive(),
  body: z.unknown(),
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export const recordKey = {
  profile: (userId: string) => `profile:${userId}`,
  device: (userId: string, deviceId: string) => `device:${userId}:${deviceId}`,
  devicePrefix: (userId: string) => `device:${userId}:`,
  friends: (userId: string) => `friends:${userId}`,
  space: (spaceId: string) => `space:${spaceId}`,
  invite: (code: string) => `invite:${code}`,
  member: (spaceId: string, userId: string) => `member:${spaceId}:${userId}`,
  memberPrefix: (spaceId: string) => `member:${spaceId}:`,
};

/** Replication order: records later in this list may depend on earlier ones. */
export const RECORD_KIND_ORDER: Record<RecordKind, number> = {
  profile: 0,
  device: 1,
  friends: 2,
  space: 3,
  invite: 4,
  member: 5,
};
