import { afterEach, describe, expect, it } from 'vitest';
import { Directory, isPrivateHost } from '@crocodile/directory';
import {
  createIdentity,
  decodeServerAddress,
  encodeServerAddress,
  openDirectoryEntry,
  sign,
} from '@crocodile/crypto';
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
    const text = await (await fetch(`${d.url}/v1/servers`)).text();
    const res = JSON.parse(text);
    expect(res.servers[0].server.id).toBe(c.info.id);

    // The public listing never shows the address in plain text…
    const { hostname, port } = new URL(c.url);
    expect(text).not.toContain(c.url);
    expect(text).not.toContain(`${hostname}:${port}`);
    expect(res.servers[0].server.url).toBeUndefined();
    // …but apps decode it and verify the server's signature over the real one.
    expect(openDirectoryEntry(res.servers[0])?.server.url).toBe(c.url);
    // A swapped address fails the signature check.
    const swapped = {
      ...res.servers[0],
      server: { ...res.servers[0].server, addr: encodeServerAddress('http://203.0.113.66:7443') },
    };
    expect(openDirectoryEntry(swapped)).toBeNull();
  });

  it('obfuscates addresses differently every time and rejects garbage', () => {
    const url = 'http://203.0.113.9:7443';
    const a = encodeServerAddress(url);
    const b = encodeServerAddress(url);
    expect(a).not.toBe(b);
    expect(a).not.toContain('203.0.113');
    expect(decodeServerAddress(a)).toBe(url);
    expect(decodeServerAddress(b)).toBe(url);
    expect(decodeServerAddress('a1.not-valid')).toBeNull();
    expect(decodeServerAddress(url)).toBeNull();
    expect(decodeServerAddress(a.slice(0, -4) + 'AAAA')).toBeNull();
  });

  it('rejects forged and unreachable entries', async () => {
    const d = await directory();
    const id = createIdentity();
    const server = {
      id: id.userId,
      key: id.publicKey,
      name: 'ghost',
      url: 'http://127.0.0.1:1',
      version: '0',
    };
    const load = { users: 0, capacity: 1 };
    const signedAt = Date.now();
    const sig = sign(id, SIG_DOMAIN.directory, { server, load, signedAt });
    expect(await d.register({ server, load, signedAt, sig })).toMatchObject({
      ok: false,
      status: 422,
    });
    expect(
      await d.register({ server: { ...server, name: 'evil' }, load, signedAt, sig }),
    ).toMatchObject({ ok: false, status: 401 });
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
    await waitFor(
      () => a.mesh.peerIds().includes(b.info.id) && b.mesh.peerIds().includes(a.info.id),
      5000,
      'mesh via directory',
    );
    // A server's public info lists its mesh peers without their addresses.
    const info = await (await fetch(`${a.url}/v1/info`)).text();
    expect(info).not.toContain(b.url);
    expect(JSON.parse(info).peers[0].id).toBe(b.info.id);
  });
});
