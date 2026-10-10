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
    // IPv4 addresses written as IPv6 reach the same machines.
    for (const h of [
      '[::ffff:127.0.0.1]',
      new URL('http://[::ffff:127.0.0.1]/').hostname,
      new URL('http://[::ffff:10.0.0.1]/').hostname,
      '[::ffff:c0a8:104]',
      '[64:ff9b::10.1.2.3]',
      '[::]',
      '[fd12:3456::1]',
      '[fe80::1%25eth0]',
      new URL('http://0x7f.1/').hostname,
    ])
      expect(isPrivateHost(h), h).toBe(true);
    expect(isPrivateHost('[::ffff:203.0.113.9]')).toBe(false);
    expect(isPrivateHost('[2001:db8::1]')).toBe(false);
    // Names that merely start like a private IPv6 prefix are public names.
    expect(isPrivateHost('fdroid.example.org')).toBe(false);
    expect(isPrivateHost('fcbarcelona.example')).toBe(false);
  });

  it('limits how often one address registers, and how many servers it lists', async () => {
    const d = await new Directory({
      host: '127.0.0.1',
      port: 0,
      allowPrivateUrls: true,
      verifyReachability: false,
      registrationsPerMinute: 3,
      maxEntries: 2,
    }).start();
    cleanup.push(() => d.stop());
    const entry = (n: number) => {
      const id = createIdentity();
      const server = {
        id: id.userId,
        key: id.publicKey,
        name: `s${n}`,
        url: `http://127.0.0.1:${1000 + n}`,
        version: '0',
      };
      const load = { users: 0, capacity: 1 };
      const signedAt = Date.now();
      return {
        server,
        load,
        signedAt,
        sig: sign(id, SIG_DOMAIN.directory, { server, load, signedAt }),
      };
    };
    const post = (body: unknown) =>
      fetch(`${d.url}/v1/servers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post(entry(1))).status).toBe(200);
    expect((await post(entry(2))).status).toBe(200);
    // Full: a third server isn't listed.
    expect((await post(entry(3))).status).toBe(503);
    // And one address can't keep trying.
    expect((await post(entry(4))).status).toBe(429);
    expect(d.listing().servers).toHaveLength(2);
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
