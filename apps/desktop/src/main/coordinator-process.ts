/**
 * Utility process running an embedded coordination server, for users who opt
 * in to contributing one to the mesh (or want a private LAN server).
 */
import { networkInterfaces } from 'node:os';
import { Coordinator } from '@crocodile/coordinator';
import type { CoordinatorProcessIn, CoordinatorProcessOut, CoordinatorStatus } from './ipc-types';

const port = (
  process as unknown as {
    parentPort: {
      on(ev: 'message', fn: (e: { data: CoordinatorProcessIn }) => void): void;
      postMessage(m: CoordinatorProcessOut): void;
    };
  }
).parentPort;
let coordinator: Coordinator | undefined;
let status: CoordinatorStatus = { state: 'stopped' };
let announced = false;

const publish = (s: CoordinatorStatus) => {
  status = s;
  port.postMessage({ type: 'status', status });
};

setInterval(() => {
  if (coordinator && status.state === 'running') {
    publish({
      ...status,
      peers: coordinator.mesh.peerIds().length,
      users: coordinator.presence.localCount,
      announced,
    });
  }
}, 5000).unref();

port.on('message', async ({ data: msg }) => {
  if (msg.type === 'status') return publish(status);
  if (msg.type === 'stop') {
    await coordinator?.stop().catch(() => {});
    coordinator = undefined;
    return publish({ state: 'stopped' });
  }
  if (msg.type === 'start') {
    await coordinator?.stop().catch(() => {});
    publish({ state: 'starting' });
    const s = msg.settings;
    try {
      coordinator = new Coordinator({
        name: s.name,
        version: msg.version,
        host: '0.0.0.0',
        port: s.port,
        publicUrl: s.publicUrl || undefined,
        dataDir: msg.dataDir,
        storage: 'sqlite',
        directoryUrls: msg.directories,
        // Listed servers say who runs them.
        announce: s.announce && !!s.publicUrl && !!s.contact,
        operatorContact: s.contact || undefined,
        meshPeers: [],
        stunPort: s.port,
        extraStun: [],
        capacity: 500,
        relay: { enabled: s.relay, maxUsers: Math.max(1, Math.min(100, s.relayMaxUsers || 10)) },
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
      await coordinator.start();
      announced = s.announce && !!s.publicUrl && !!s.contact;
      publish({
        state: 'running',
        url: `http://127.0.0.1:${new URL(coordinator.url).port || s.port}`,
        id: coordinator.info.id,
        peers: 0,
        users: 0,
        publicUrl: s.publicUrl,
        announced,
        lanUrls: lanUrls(s.port),
      });
    } catch (err) {
      coordinator = undefined;
      const message = String(err).includes('EADDRINUSE')
        ? `Port ${s.port} is already in use`
        : String(err);
      publish({ state: 'error', message });
    }
  }
});

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
