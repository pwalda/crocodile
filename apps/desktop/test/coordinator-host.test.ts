import { describe, expect, it } from 'vitest';
import { createCoordinatorHost, type ServerLike } from '../src/main/coordinator-host';
import type { CoordinatorSettings, CoordinatorStatus } from '../src/main/ipc-types';

const settings: CoordinatorSettings = {
  enabled: true,
  name: 'Home server',
  port: 7443,
  announce: false,
  relay: false,
  relayMaxUsers: 10,
  mailbox: false,
  contact: 'ops@example.org',
};
const start = {
  type: 'start' as const,
  settings,
  dataDir: '/tmp/x',
  directories: [],
  version: '1',
};

/** Servers that take a moment to start and stop, and note which are running. */
function fakeServers() {
  const running = new Set<number>();
  let n = 0;
  const make = (): ServerLike => {
    const id = n++;
    return {
      start: async () => {
        await new Promise((r) => setTimeout(r, 30));
        running.add(id);
      },
      stop: async () => {
        await new Promise((r) => setTimeout(r, 10));
        running.delete(id);
      },
      url: 'http://127.0.0.1:7443',
      info: { id: `server${id}` },
      mesh: { peerIds: () => [] },
      presence: { localCount: 0 },
    } as unknown as ServerLike;
  };
  return { running, make };
}

describe("the app's own server, started and stopped quickly", () => {
  it('runs one server at a time, and a stop sent during a start wins', async () => {
    const servers = fakeServers();
    const statuses: CoordinatorStatus[] = [];
    const host = createCoordinatorHost((s) => statuses.push(s), servers.make);
    // Settings saved twice in a row, then the server turned off.
    void host.send(start);
    void host.send(start);
    await host.send({ type: 'stop' });
    expect(servers.running.size).toBe(0);
    expect(statuses.at(-1)).toEqual({ state: 'stopped' });

    void host.send(start);
    await host.send(start);
    expect(servers.running.size).toBe(1);
    expect(statuses.at(-1)?.state).toBe('running');
  });
});
