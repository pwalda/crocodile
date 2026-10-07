import { describe, expect, it } from 'vitest';
import { coordinatorStartError } from '../src/main/coordinator-config';
import type { CoordinatorSettings } from '../src/main/ipc-types';

const settings: CoordinatorSettings = {
  enabled: true,
  name: 'Home server',
  port: 7443,
  announce: false,
  relay: false,
  relayMaxUsers: 10,
  mailbox: false,
};

describe("the app's own server", () => {
  it('refuses to start without an operator contact, as older versions saved it', () => {
    expect(coordinatorStartError(settings)).toMatch(/operator contact/);
    expect(coordinatorStartError({ ...settings, contact: 'javascript:alert(1)' })).toMatch(
      /email address or a page/,
    );
  });

  it('starts with an email address or an https page', () => {
    expect(coordinatorStartError({ ...settings, contact: 'ops@example.org' })).toBeUndefined();
    expect(
      coordinatorStartError({ ...settings, contact: 'https://example.org/privacy' }),
    ).toBeUndefined();
  });
});
