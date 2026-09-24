import { z } from 'zod';
import { ServerInfo } from './rpc';

/**
 * The directory service is the only central piece: a phone book of
 * coordination servers. It never sees users, records or content.
 */
export const DirectoryEntry = z.object({
  server: ServerInfo,
  load: z.object({
    users: z.number().int().min(0),
    capacity: z.number().int().min(0),
  }),
  signedAt: z.number().int(),
  /** Server's signature over (server, load, signedAt). */
  sig: z.string(),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;

/**
 * How a server appears in public listings: its address is not shown in
 * plain text but as `addr`, an obfuscated form the apps decode (see
 * encodeServerAddress in @crocodile/crypto). Obfuscation, not secrecy:
 * it keeps addresses away from search engines and casual scraping.
 */
export const PublicServerInfo = ServerInfo.omit({ url: true }).extend({
  addr: z.string().max(1024),
});
export type PublicServerInfo = z.infer<typeof PublicServerInfo>;

export const PublicDirectoryEntry = DirectoryEntry.extend({
  server: PublicServerInfo,
  lastSeen: z.number().int(),
});
export type PublicDirectoryEntry = z.infer<typeof PublicDirectoryEntry>;

export interface DirectoryListing {
  servers: PublicDirectoryEntry[];
  generatedAt: number;
}

export const DIRECTORY_PATHS = {
  register: '/v1/servers',
  list: '/v1/servers',
  health: '/health',
} as const;
