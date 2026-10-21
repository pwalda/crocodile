import { describe, expect, it } from 'vitest';
import { coordinatorStartError, relayPorts } from '../src/main/coordinator-config';
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

  it('relays on a fixed range of ports, which a router can forward', () => {
    expect(relayPorts(settings)).toEqual({ min: 7445, max: 7484 });
    expect(relayPorts({ ...settings, port: 9000, relayMaxUsers: 3 })).toEqual({
      min: 9002,
      max: 9013,
    });
    // Too close to the top for the relay's ports: refused, rather than fewer ports.
    const high = { ...settings, contact: 'ops@example.org', relay: true, relayMaxUsers: 100 };
    expect(coordinatorStartError({ ...high, port: 65530 })).toMatch(/65134 or lower/);
    expect(coordinatorStartError({ ...high, port: 65134 })).toBeUndefined();
    expect(coordinatorStartError({ ...high, port: 65534, relay: false })).toBeUndefined();
  });
});
