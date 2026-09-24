import { afterEach, describe, expect, it } from 'vitest';
import { Directory, isPrivateHost } from '@crocodile/directory';
import { createIdentity, sign } from '@crocodile/crypto';
import { SIG_DOMAIN } from '@crocodile/protocol';
import { startCoordinator, waitFor } from './helpers';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function directory() {
  const d = await new Directory({ host: '127.0.0.1', port: 0, allowPrivateUrls: true }).start();
  cleanup.push(() => d.stop());
  return d;
}

describe('directory', () => {
  it('lists servers that register with a valid, reachable entry', async () => {
    const d = await directory();
    const c = await startCoordinator({ directoryUrls: [d.url], announce: true });
    cleanup.push(() => c.stop());
    await waitFor(() => d.listing().servers.length === 1, 3000, 'registration');
    const res = await (await fetch(`${d.url}/v1/servers`)).json();
    expect(res.servers[0].server.id).toBe(c.info.id);
  });

  it('rejects forged and unreachable entries', async () => {
    const d = await directory();
    const id = createIdentity();
    const server = { id: id.userId, key: id.publicKey, name: 'ghost', url: 'http://127.0.0.1:1', version: '0' };
    const load = { users: 0, capacity: 1 };
    const signedAt = Date.now();
    const sig = sign(id, SIG_DOMAIN.directory, { server, load, signedAt });
    expect(await d.register({ server, load, signedAt, sig })).toMatchObject({ ok: false, status: 422 });
    expect(await d.register({ server: { ...server, name: 'evil' }, load, signedAt, sig })).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses private URLs on a public directory', () => {
    expect(isPrivateHost('192.168.1.4')).toBe(true);
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('[::1]')).toBe(true);
    expect(isPrivateHost('croc.example.org')).toBe(false);
    expect(isPrivateHost('203.0.113.9')).toBe(false);
  });

  it('servers discover and link with each other through the directory', async () => {
    const d = await directory();
    const a = await startCoordinator({ name: 'A', directoryUrls: [d.url], announce: true });
    cleanup.push(() => a.stop());
    const b = await startCoordinator({ name: 'B', directoryUrls: [d.url], announce: true });
    cleanup.push(() => b.stop());
    // A registered before B existed; B's first tick sees A and dials it.
    await waitFor(() => a.mesh.peerIds().includes(b.info.id) && b.mesh.peerIds().includes(a.info.id), 5000, 'mesh via directory');
  });
});
