export const PROTOCOL_VERSION = 1;
export const APP_NAME = 'Crocodile';

/** Number of simultaneous speaker slots a host relay forwards to each listener. */
export const DEFAULT_RELAY_SLOTS = 5;

export const LIMITS = {
  usernameMax: 32,
  bioMax: 190,
  /** Avatars are stored inline in the signed profile as a data URL. */
  avatarMaxBytes: 256 * 1024,
  spaceNameMax: 64,
  channelNameMax: 64,
  channelsPerSpace: 200,
  friendsMax: 2000,
  messageMaxChars: 4000,
  recordMaxBytes: 400 * 1024,
  wsMessageMaxBytes: 1024 * 1024,
  sessionMembersMax: 100,
} as const;

/** Signature domain separation prefixes. Never reuse one for a different purpose. */
export const SIG_DOMAIN = {
  record: 'croc/v1/record',
  auth: 'croc/v1/auth',
  serverHello: 'croc/v1/server-hello',
  federation: 'croc/v1/federation',
  directory: 'croc/v1/directory',
  signal: 'croc/v1/signal',
  message: 'croc/v1/message',
  senderKey: 'croc/v1/sender-key',
  sealed: 'croc/v1/sealed',
} as const;
