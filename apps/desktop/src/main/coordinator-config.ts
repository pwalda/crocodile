import { isOperatorContact } from '@crocodile/protocol';
import type { CoordinatorSettings } from './ipc-types';

/**
 * Why the app's own server can't start with these settings, or undefined if
 * it can. Settings saved by older versions may be enabled without a contact.
 */
export function coordinatorStartError(s: CoordinatorSettings): string | undefined {
  // People using a server must be able to reach whoever runs it.
  if (!s.contact) return 'Add an operator contact below to run your server.';
  if (!isOperatorContact(s.contact))
    return 'The operator contact must be an email address or a page starting with https://.';
  return undefined;
}

/** Relay capacity as the server applies it: 1 to 100 people. */
export function relayCapacity(s: CoordinatorSettings): number {
  return Math.max(1, Math.min(100, s.relayMaxUsers || 10));
}

/**
 * UDP ports for relayed traffic, one per relayed connection: a fixed range
 * just above the server's own two ports, so it can be forwarded on a router
 * (a port chosen at random for each connection can't be).
 */
export function relayPorts(s: CoordinatorSettings): { min: number; max: number } {
  const min = s.port + 2;
  // Four per person, as each may hold up to four relayed connections.
  return { min, max: Math.min(65535, min + relayCapacity(s) * 4 - 1) };
}
