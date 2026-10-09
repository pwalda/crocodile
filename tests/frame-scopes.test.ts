import { describe, expect, it } from 'vitest';
import { FrameScopes, GroupKeyring } from '@crocodile/client-core';
import { AudioReceiver, importChain } from '@crocodile/crypto';

const counterOf = (f: Uint8Array) =>
  new DataView(f.buffer, f.byteOffset + f.length - 11, 11).getUint32(6);

describe('voice frame keys in the worker', () => {
  it('continues the frame counter when a call reconnects, instead of reusing nonces', () => {
    const keyring = new GroupKeyring({ autoRatchet: false });
    const scopes = new FrameScopes();
    const frame = new Uint8Array(60);
    // First connection.
    scopes.update('conn-1', keyring.frameKeys());
    const a = [1, 2, 3].map(() => scopes.get('conn-1')!.sender!.encrypt(frame));
    // The call reconnects: a new connection gets a new scope with the same keys.
    scopes.update('conn-2', keyring.frameKeys());
    const b = scopes.get('conn-2')!.sender!.encrypt(frame);
    const counters = [...a, b].map(counterOf);
    expect(new Set(counters).size).toBe(4);
    expect(counters[3]).toBe((counters[2]! + 1) >>> 0);
    // Listeners still decrypt both.
    const mine = keyring.exportMine();
    const rx = new AudioReceiver(keyring.kid, importChain(mine.audio));
    expect(rx.decrypt(a[0]!)).toEqual(frame);
    expect(rx.decrypt(b)).toEqual(frame);

    // Dropping the old connection keeps the sender the new one uses.
    scopes.drop('conn-1');
    scopes.update('conn-3', keyring.frameKeys());
    expect(counterOf(scopes.get('conn-3')!.sender!.encrypt(frame))).toBe((counters[3]! + 1) >>> 0);
    keyring.dispose();
  });
});
