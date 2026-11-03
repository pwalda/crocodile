import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupKeyring } from '@crocodile/client-core';
import { createSenderKey, encryptText, exportChains } from '@crocodile/crypto';

afterEach(() => vi.useRealTimers());

describe('keys from other members', () => {
  function pair() {
    const alice = new GroupKeyring({ autoRatchet: false });
    const bob = new GroupKeyring({ autoRatchet: false });
    return { alice, bob, kids: () => bob.frameKeys().peers.map((p) => p.kid) };
  }

  it('does not take back a key the sender has replaced, when it is sent again', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { alice, bob, kids } = pair();
    const first = alice.exportMine();
    expect(bob.addPeerKey('alice.d1', first, 1000)).toBe(true);
    const second = alice.rotate();
    expect(bob.addPeerKey('alice.d1', second, 2000)).toBe(true);
    // The replaced key is dropped after a short grace...
    vi.setSystemTime(Date.now() + 11_000);
    expect(kids()).toEqual([second.kid]);
    // ...and a copy of the message that carried it, replayed later, doesn't bring it back.
    expect(bob.addPeerKey('alice.d1', first, 1000)).toBe(false);
    expect(kids()).toEqual([second.kid]);
  });

  it('refuses a key sealed before the newest one taken from that member', () => {
    const { alice, bob, kids } = pair();
    const first = alice.exportMine();
    const second = alice.rotate();
    expect(bob.addPeerKey('alice.d1', second, 2000)).toBe(true);
    // Delivered late: it would make the old key the current one and let the new one lapse.
    expect(bob.addPeerKey('alice.d1', first, 1000)).toBe(false);
    expect(kids()).toEqual([second.kid]);
  });

  it('takes the same key sent again, and a key after a member has been away', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { alice, bob, kids } = pair();
    const key = alice.exportMine();
    expect(bob.addPeerKey('alice.d1', key, 1000)).toBe(true);
    expect(bob.addPeerKey('alice.d1', key, 2000)).toBe(true);
    // Away and back with the key they had: it was never replaced.
    bob.peerLeft('alice.d1');
    vi.setSystemTime(Date.now() + 11_000);
    expect(kids()).toEqual([]);
    expect(bob.addPeerKey('alice.d1', key, 3000)).toBe(true);
    expect(kids()).toEqual([key.kid]);
  });
});

describe('key ids are public', () => {
  const say = (k: { kid: number; g: number; ct: string }) => [k.kid, k.g, k.ct] as const;

  it("takes a member's key although another member sent a key under the same id first", () => {
    const alice = new GroupKeyring({ autoRatchet: false });
    const bob = new GroupKeyring({ autoRatchet: false });
    // Mallory has seen Alice's id (it is in every message) and uses it for a key of her own.
    const squat = createSenderKey();
    squat.kid = alice.kid;
    expect(bob.addPeerKey('mallory.d1', exportChains(squat), 1000)).toBe(true);
    expect(bob.addPeerKey('alice.d1', alice.exportMine(), 1000)).toBe(true);
    expect(bob.hasKeyFrom('alice.d1')).toBe(true);
    // Each opens only what its own sender sent.
    const fromAlice = say(alice.encrypt(new TextEncoder().encode('hi')));
    expect(bob.decrypt('alice.d1', ...fromAlice)).toEqual(new TextEncoder().encode('hi'));
    const fromMallory = say(encryptText(squat, new TextEncoder().encode('boo')));
    expect(bob.decrypt('mallory.d1', ...fromMallory)).toEqual(new TextEncoder().encode('boo'));
    // And a message is never opened as someone else's.
    expect(bob.decrypt('mallory.d1', ...say(alice.encrypt(new Uint8Array(4))))).toBeNull();
    // The voice worker is told of both.
    expect(
      bob
        .frameKeys()
        .peers.map((p) => [p.peer, p.kid])
        .sort(),
    ).toEqual([
      ['alice.d1', alice.kid],
      ['mallory.d1', alice.kid],
    ]);
    // Removing one leaves the other.
    bob.forgetPeer('mallory.d1');
    expect(bob.frameKeys().peers.map((p) => p.peer)).toEqual(['alice.d1']);
  });
});
