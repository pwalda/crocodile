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

export interface DirectoryListing {
  servers: (DirectoryEntry & { lastSeen: number })[];
  generatedAt: number;
}

export const DIRECTORY_PATHS = {
  register: '/v1/servers',
  list: '/v1/servers',
  health: '/health',
} as const;
