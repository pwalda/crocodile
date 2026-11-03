import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  badgeCount,
  coordinatorPatch,
  exportEnding,
  pttCode,
  relayMessage,
  secureKey,
  secureValue,
  webUrl,
  withCoordinatorPatch,
} from '../apps/desktop/src/main/ipc-args';
import type { CoordinatorSettings } from '../apps/desktop/src/main/ipc-types';

const current: CoordinatorSettings = {
  enabled: false,
  name: 'My server',
  port: 7443,
  announce: true,
  relay: false,
  relayMaxUsers: 10,
  mailbox: false,
  publicUrl: 'https://example.org',
  contact: 'me@example.org',
};

describe('settings of the app’s own server', () => {
  it('takes what the settings page sends', () => {
    expect(
      coordinatorPatch({
        enabled: true,
        name: 'Ours',
        port: 8000,
        announce: false,
        relay: true,
        relayMaxUsers: 20,
        mailbox: true,
        publicUrl: 'https://chat.example.org:8443',
        contact: 'https://example.org/contact',
      }),
    ).toEqual({
      enabled: true,
      name: 'Ours',
      port: 8000,
      announce: false,
      relay: true,
      relayMaxUsers: 20,
      mailbox: true,
      publicUrl: 'https://chat.example.org:8443',
      contact: 'https://example.org/contact',
    });
    // An address and a contact are cleared by leaving them out or empty.
    const cleared = withCoordinatorPatch(current, { publicUrl: undefined, contact: '' });
    expect(cleared.publicUrl).toBeUndefined();
    expect(cleared.contact).toBeUndefined();
  });

  it('keeps nothing else, and nothing that is out of range or of the wrong kind', () => {
    const next = withCoordinatorPatch(current, {
      enabled: 'yes',
      name: 'x'.repeat(101),
      port: 70000,
      relayMaxUsers: 1000,
      mailbox: 1,
      publicUrl: 'file:///etc/passwd',
      contact: 'not a contact',
      // Not settings: they are never written down.
      command: 'rm -rf ~',
      constructor: { prototype: { polluted: true } },
      ...JSON.parse('{"__proto__": {"polluted": true}}'),
    });
    expect(next).toEqual(current);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    for (const bad of [null, undefined, 'port', 7, ['port'], () => 1])
      expect(coordinatorPatch(bad), String(bad)).toEqual({});
    for (const port of [0, -1, 1.5, NaN, Infinity, '7443', 65536])
      expect(coordinatorPatch({ port }), String(port)).toEqual({});
    expect(coordinatorPatch({ name: 'two\nlines' })).toEqual({});
    expect(coordinatorPatch({ name: '' })).toEqual({});
    expect(coordinatorPatch({ name: ' '.repeat(50) })).toEqual({});
    // A contact is an email address or an https:// page, as everyone else's apps will read it.
    for (const contact of [
      'javascript:alert(1)',
      'me@example.org and more',
      'http://example.org',
      'x'.repeat(201),
    ])
      expect(coordinatorPatch({ contact }), contact).toEqual({});
    expect(coordinatorPatch({ relayMaxUsers: 0 })).toEqual({});
  });
});

describe('messages for the relay process', () => {
  const start = {
    type: 'start',
    handle: 'h1',
    seed: 'c2VlZA',
    hostPeer: 'aaaaaaaaaaaaaaaaaaaaaaaaaa.deviceaa',
    sessionId: 'dm:x',
    epoch: 3,
    slots: 5,
    iceServers: [{ urls: 'stun:stun.example.org:7443' }],
  };

  it('passes the messages the app sends, rebuilt from the parts that are used', () => {
    expect(relayMessage({ ...start, extra: 'dropped' })).toEqual(start);
    expect(relayMessage({ type: 'members', handle: 'h1', members: ['a', 'b'] })).toEqual({
      type: 'members',
      handle: 'h1',
      members: ['a', 'b'],
    });
    expect(relayMessage({ type: 'close', handle: 'h1', more: 1 })).toEqual({
      type: 'close',
      handle: 'h1',
    });
    expect(
      relayMessage({
        type: 'signal',
        handle: 'h1',
        from: 'p.d1',
        data: { type: 'bye', epoch: 1, dir: 'toRelay' },
      }),
    ).toEqual({
      type: 'signal',
      handle: 'h1',
      from: 'p.d1',
      data: { type: 'bye', epoch: 1, dir: 'toRelay' },
    });
  });

  it('uses the first few STUN addresses a server names, and those that fit', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ urls: `stun:s${i}.example.org:7443` }));
    expect(relayMessage({ ...start, iceServers: many })).toMatchObject({
      iceServers: many.slice(0, 8),
    });
    expect(
      relayMessage({
        ...start,
        iceServers: [{ urls: 7 }, 'stun:a', { urls: 'x'.repeat(301) }, { urls: 'stun:ok' }],
      }),
    ).toMatchObject({ iceServers: [{ urls: 'stun:ok' }] });
  });

  it('does not go through a long list of them', () => {
    const junk = Array.from({ length: 64 }, () => 'not a server');
    expect(relayMessage({ ...start, iceServers: [...junk, { urls: 'stun:late' }] })).toMatchObject({
      iceServers: [],
    });
  });

  it('refuses anything else', () => {
    for (const bad of [
      null,
      'start',
      [],
      {},
      { type: 'close' },
      { type: 'close', handle: '' },
      { type: 'close', handle: 'h'.repeat(101) },
      { type: 'eval', handle: 'h1' },
      { ...start, slots: 100_000 },
      { ...start, slots: -1 },
      { ...start, slots: 1.5 },
      { ...start, epoch: 'x' },
      { ...start, seed: 's'.repeat(101) },
      { ...start, iceServers: 'stun:a' },
      { type: 'members', handle: 'h1', members: 'a' },
      { type: 'members', handle: 'h1', members: Array.from({ length: 1001 }, () => 'a') },
      { type: 'members', handle: 'h1', members: [7] },
      { type: 'signal', handle: 'h1', from: 'p.d1', data: { type: 'nope' } },
      { type: 'signal', handle: 'h1', data: { type: 'bye', epoch: 1, dir: 'toRelay' } },
    ])
      expect(relayMessage(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
  });
});

describe('the small ones', () => {
  it('opens only web addresses', () => {
    expect(webUrl('https://example.org/a?b=c')).toBe('https://example.org/a?b=c');
    expect(webUrl('HTTP://example.org')).toBe('http://example.org/');
    // Links with signed parameters are long.
    expect(webUrl(`https://example.org/?q=${'a'.repeat(4000)}`)).toContain('example.org');
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'smb://host/share',
      'ms-msdt:/id',
      'https://',
      'example.org',
      '',
      7,
      null,
      `https://example.org/${'a'.repeat(8200)}`,
    ])
      expect(webUrl(bad), String(bad).slice(0, 40)).toBeNull();
  });

  it('shows a whole number on the icon, or none', () => {
    expect(badgeCount(0)).toBe(0);
    expect(badgeCount(12)).toBe(12);
    expect(badgeCount(99_999)).toBe(99_999);
    for (const bad of [-1, 1.5, NaN, Infinity, 100_000, '5', null, undefined, {}])
      expect(badgeCount(bad), String(bad)).toBe(0);
  });

  it('ends a saved file in one of three ways', () => {
    for (const ok of ['open', 'reveal', 'none'] as const) expect(exportEnding(ok)).toBe(ok);
    for (const bad of ['OPEN', 'run', '', null, undefined, 1])
      expect(() => exportEnding(bad), String(bad)).toThrow();
  });

  it('keeps to the names the app has in the secure store, and a value of a size it can hold', () => {
    for (const ok of ['identity-seed', 'prekeys', 'local-data-key']) expect(secureKey(ok)).toBe(ok);
    for (const bad of [
      '',
      'other',
      'constructor',
      'toString',
      '__proto__',
      'identity-seed ',
      7,
      null,
      undefined,
      {},
    ])
      expect(() => secureKey(bad), String(bad)).toThrow();
    expect(secureValue('')).toBe('');
    expect(secureValue('x'.repeat(1024 * 1024))).toHaveLength(1024 * 1024);
    // A megabyte of bytes, not of characters.
    for (const bad of [
      'x'.repeat(1024 * 1024 + 1),
      'ż'.repeat(600_000),
      7,
      null,
      undefined,
      {},
      new Uint8Array(2),
    ])
      expect(() => secureValue(bad)).toThrow();
  });

  it('takes a key for push-to-talk, or none', () => {
    expect(pttCode(null)).toBeNull();
    expect(pttCode('KeyV')).toBe('KeyV');
    for (const bad of ['', 'k'.repeat(65), 7, undefined, {}]) expect(() => pttCode(bad)).toThrow();
  });
});

describe('the main process asks for these checks', () => {
  // The handlers need Electron to run, so what is looked at here is that each one passes what it
  // is sent through its check before using it.
  const main = readFileSync(new URL('../apps/desktop/src/main/main.ts', import.meta.url), 'utf8');
  const handler = (channel: string) => {
    const start = main.indexOf(`handle('${channel}'`);
    expect(start, channel).toBeGreaterThanOrEqual(0);
    const end = main.slice(start + 1).search(/\n(handle\(|\/\/ -{10})/);
    return main.slice(start, end < 0 ? undefined : start + 1 + end);
  };

  it.each([
    ['secure:get', ['secureKey(']],
    ['secure:set', ['secureKey(', 'secureValue(']],
    ['secure:delete', ['secureKey(']],
    ['relay:send', ['relayMessage(']],
    ['coordinator:set', ['withCoordinatorPatch(']],
    ['files:end', ['exportEnding(']],
    ['app:open-external', ['webUrl(']],
    ['app:badge', ['badgeCount(']],
    ['ptt:configure', ['pttCode(']],
  ])('%s', (channel, checks) => {
    const body = handler(channel);
    for (const check of checks) expect(body).toContain(check);
  });
});
