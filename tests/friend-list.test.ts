import { describe, expect, it } from 'vitest';
import { NOTE_TTL_MS } from '@crocodile/protocol';
import {
  decodeFriendList,
  emptyEntry,
  encodeFriendList,
  friendsView,
  mergeFriendLists,
  pruneFriendList,
  type FriendList,
} from '../packages/client-core/src/friend-list';

const id = (c: string) => c.repeat(26);

describe('friend list', () => {
  it('round-trips through its binary form', () => {
    const list: FriendList = new Map([
      [
        id('a'),
        { mine: 'listed', mineAt: 1_700_000_000_123, theirs: true, theirsAt: 5, sentAt: 7 },
      ],
      [id('b'), { ...emptyEntry(), mine: 'blocked', mineAt: 2 }],
      [id('c'), { ...emptyEntry(), theirs: true, theirsAt: 2 ** 47 }],
    ]);
    const bytes = encodeFriendList(list);
    expect(bytes.length).toBe(1 + 3 * 45);
    expect(decodeFriendList(bytes)).toEqual(list);
    expect(decodeFriendList(bytes.subarray(0, 40))).toBeNull();
    expect(decodeFriendList(new Uint8Array([2]))).toBeNull();
  });

  it('merges two devices’ copies without losing either change', () => {
    // Laptop accepted Alice while the phone read Bob's request.
    const laptop: FriendList = new Map([
      [id('a'), { mine: 'listed', mineAt: 20, theirs: true, theirsAt: 10, sentAt: 20 }],
    ]);
    const phone: FriendList = new Map([
      [id('a'), { mine: 'none', mineAt: 0, theirs: true, theirsAt: 10, sentAt: 0 }],
      [id('b'), { ...emptyEntry(), theirs: true, theirsAt: 15 }],
    ]);
    const merged = mergeFriendLists(phone, laptop);
    expect(merged).toEqual(mergeFriendLists(laptop, phone));
    expect(friendsView(merged, new Set())).toEqual({
      friends: [id('a')],
      incoming: [id('b')],
      outgoing: [],
      blocked: [],
    });
  });

  it('forgets only entries that say nothing any more', () => {
    const now = Date.now();
    const old = now - NOTE_TTL_MS - 1;
    const list: FriendList = new Map([
      [id('a'), { ...emptyEntry(), mineAt: old, theirsAt: old, sentAt: old }],
      [id('b'), { ...emptyEntry(), mineAt: now, theirsAt: old }],
      // Still owed a note telling them we stopped listing them.
      [id('c'), { ...emptyEntry(), mineAt: old, sentAt: old - 1 }],
      [id('d'), { ...emptyEntry(), mine: 'blocked', mineAt: old, sentAt: old }],
    ]);
    pruneFriendList(list, now);
    expect([...list.keys()]).toEqual([id('b'), id('c'), id('d')]);
  });
});
