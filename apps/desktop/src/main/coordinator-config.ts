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
