/**
 * The embedded coordination server's lifecycle, driven by messages from the
 * main process. Messages are handled one at a time: a start or stop arriving
 * while another is under way waits for it, so two servers never race for the
 * port and a stop is never undone by a start that was still finishing.
 */
import { networkInterfaces } from 'node:os';
import { Coordinator } from '@crocodile/coordinator';
import type { CoordinatorProcessIn, CoordinatorStatus } from './ipc-types';
import { coordinatorStartError } from './coordinator-config';

/** What the host needs of a server (a Coordinator; tests pass a stand-in). */
export type ServerLike = Pick<Coordinator, 'start' | 'stop' | 'url' | 'info' | 'mesh' | 'presence'>;

export function createCoordinatorHost(
  onStatus: (s: CoordinatorStatus) => void,
  makeServer: (config: ConstructorParameters<typeof Coordinator>[0]) => ServerLike = (c) =>
    new Coordinator(c),
) {
  let coordinator: ServerLike | undefined;
  let status: CoordinatorStatus = { state: 'stopped' };
  let announced = false;
  let queue = Promise.resolve();

  const publish = (s: CoordinatorStatus) => {
    status = s;
    onStatus(status);
  };

  async function handle(msg: CoordinatorProcessIn) {
    if (msg.type === 'status') return publish(status);
    if (msg.type === 'stop') {
      await coordinator?.stop().catch(() => {});
      coordinator = undefined;
      return publish({ state: 'stopped' });
    }
    if (msg.type === 'start') {
      await coordinator?.stop().catch(() => {});
      coordinator = undefined;
      const s = msg.settings;
      const refused = coordinatorStartError(s);
      if (refused) return publish({ state: 'error', message: refused });
      publish({ state: 'starting' });
      try {
        const server = makeServer({
          name: s.name,
          version: msg.version,
          host: '0.0.0.0',
          port: s.port,
          publicUrl: s.publicUrl || undefined,
          dataDir: msg.dataDir,
          storage: 'sqlite',
          directoryUrls: msg.directories,
          announce: s.announce && !!s.publicUrl,
          operatorContact: s.contact,
          meshPeers: [],
          stunPort: s.port,
          extraStun: [],
          capacity: 500,
          relay: {
            enabled: s.relay,
            maxUsers: Math.max(1, Math.min(100, s.relayMaxUsers || 10)),
          },
          // Small quotas: a home computer is not a mail server.
          mailbox: {
            enabled: !!s.mailbox,
            ttlMs: 3 * 24 * 3600_000,
            maxPerRecipient: 200,
            maxPerSender: 500,
            maxTotal: 20_000,
          },
          logLevel: 'warn',
        });
        coordinator = server;
        await server.start();
        announced = s.announce && !!s.publicUrl;
        publish({
          state: 'running',
          url: `http://127.0.0.1:${new URL(server.url).port || s.port}`,
          id: server.info.id,
          peers: 0,
          users: 0,
          publicUrl: s.publicUrl,
          announced,
          lanUrls: lanUrls(s.port),
        });
      } catch (err) {
        await coordinator?.stop().catch(() => {});
        coordinator = undefined;
        const message = String(err).includes('EADDRINUSE')
          ? `Port ${s.port} is already in use`
          : String(err);
        publish({ state: 'error', message });
      }
    }
  }

  return {
    /** Queues a message; resolves once it (and everything before it) is handled. */
    send(msg: CoordinatorProcessIn): Promise<void> {
      queue = queue.then(() => handle(msg)).catch(() => {});
      return queue;
    },
    /** Live numbers for the status, while running. */
    refresh() {
      if (coordinator && status.state === 'running') {
        publish({
          ...status,
          peers: coordinator.mesh.peerIds().length,
          users: coordinator.presence.localCount,
          announced,
        });
      }
    },
  };
}

/** http://<address>:<port> for every non-internal IPv4 interface. */
function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}
