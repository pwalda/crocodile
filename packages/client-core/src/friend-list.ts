import { NOTE_TTL_MS } from '@crocodile/protocol';

/**
 * This account's relationships as its own devices keep them. The list is
 * stored sealed in the `friends:<me>` record, so only our devices can read
 * it; the other side of each relationship hears about it through notes.
 *
 * Each entry has halves that are each last-writer-wins on their own clock, so
 * copies written by two devices at once merge without losing either change:
 *  - mine: whether we list them (a request, or a friendship once they list us
 *    too) or block them;
 *  - theirs: whether they list us, as their latest note said;
 *  - sentAt: the `mineAt` they were last told about. While it is behind
 *    `mineAt`, they still need a note.
 */
export type Mine = 'none' | 'listed' | 'blocked';

export interface FriendEntry {
  mine: Mine;
  mineAt: number;
  theirs: boolean;
  theirsAt: number;
  sentAt: number;
}

export type FriendList = Map<string, FriendEntry>;

export function emptyEntry(): FriendEntry {
  return { mine: 'none', mineAt: 0, theirs: false, theirsAt: 0, sentAt: 0 };
}

const MINE_ORDER: Record<Mine, number> = { none: 0, listed: 1, blocked: 2 };

/**
 * Commutative: the same result whichever copy comes first. On equal clocks
 * (two devices in the same millisecond) a fixed order of values decides.
 */
export function mergeEntry(a: FriendEntry, b: FriendEntry): FriendEntry {
  const mine =
    b.mineAt > a.mineAt || (b.mineAt === a.mineAt && MINE_ORDER[b.mine] > MINE_ORDER[a.mine])
      ? b
      : a;
  const theirs =
    b.theirsAt > a.theirsAt || (b.theirsAt === a.theirsAt && b.theirs && !a.theirs) ? b : a;
  return {
    mine: mine.mine,
    mineAt: mine.mineAt,
    theirs: theirs.theirs,
    theirsAt: theirs.theirsAt,
    sentAt: Math.max(a.sentAt, b.sentAt),
  };
}

export function mergeFriendLists(a: FriendList, b: FriendList): FriendList {
  const out: FriendList = new Map(a);
  for (const [id, e] of b) {
    const cur = out.get(id);
    out.set(id, cur ? mergeEntry(cur, e) : e);
  }
  return out;
}

/** Whether they haven't been told our latest `mine` yet. */
export function needsNote(e: FriendEntry): boolean {
  return e.sentAt < e.mineAt;
}

/** Most entries a list keeps; past this, the oldest that only record a past request go. */
const MAX_ENTRIES = 5000;

/**
 * Forgets entries that say nothing any more: neither side lists the other,
 * nobody is waiting for a note, and any note that could still change that
 * has expired.
 */
export function pruneFriendList(list: FriendList, now: number): void {
  const old = now - NOTE_TTL_MS;
  for (const [id, e] of list) {
    if (e.mine === 'none' && !e.theirs && !needsNote(e) && e.mineAt < old && e.theirsAt < old)
      list.delete(id);
  }
  if (list.size <= MAX_ENTRIES) return;
  const droppable = [...list]
    .filter(([, e]) => e.mine === 'none' && !needsNote(e))
    .sort((x, y) => Math.max(x[1].mineAt, x[1].theirsAt) - Math.max(y[1].mineAt, y[1].theirsAt));
  for (const [id] of droppable.slice(0, list.size - MAX_ENTRIES)) list.delete(id);
}

export function countMine(list: FriendList, mine: Mine): number {
  let n = 0;
  for (const e of list.values()) if (e.mine === mine) n++;
  return n;
}

// Binary form, compact enough for thousands of entries in one record:
//   0x01, then per entry: user id (26 ASCII bytes), flags (bits 0-1 mine,
//   bit 2 theirs), mineAt, theirsAt, sentAt (6 bytes each, big-endian ms).

const FORMAT = 1;
const ID_LEN = 26;
const ENTRY_LEN = ID_LEN + 1 + 18;
const MINE: Mine[] = ['none', 'listed', 'blocked'];
const USER_ID = /^[a-z2-7]{26}$/;

function putTime(out: Uint8Array, at: number, t: number) {
  let v = Math.max(0, Math.floor(t));
  for (let i = 5; i >= 0; i--) {
    out[at + i] = v % 256;
    v = Math.floor(v / 256);
  }
}

function getTime(bytes: Uint8Array, at: number): number {
  let v = 0;
  for (let i = 0; i < 6; i++) v = v * 256 + bytes[at + i]!;
  return v;
}

export function encodeFriendList(list: FriendList): Uint8Array {
  const entries = [...list].filter(([id]) => USER_ID.test(id));
  const out = new Uint8Array(1 + entries.length * ENTRY_LEN);
  out[0] = FORMAT;
  let at = 1;
  for (const [id, e] of entries) {
    for (let i = 0; i < ID_LEN; i++) out[at + i] = id.charCodeAt(i);
    out[at + ID_LEN] = MINE.indexOf(e.mine) | (e.theirs ? 4 : 0);
    putTime(out, at + ID_LEN + 1, e.mineAt);
    putTime(out, at + ID_LEN + 7, e.theirsAt);
    putTime(out, at + ID_LEN + 13, e.sentAt);
    at += ENTRY_LEN;
  }
  return out;
}

/** Null if the bytes are not a list this version understands. */
export function decodeFriendList(bytes: Uint8Array): FriendList | null {
  if (bytes[0] !== FORMAT || (bytes.length - 1) % ENTRY_LEN !== 0) return null;
  const list: FriendList = new Map();
  for (let at = 1; at < bytes.length; at += ENTRY_LEN) {
    const id = String.fromCharCode(...bytes.subarray(at, at + ID_LEN));
    const flags = bytes[at + ID_LEN]!;
    const mine = MINE[flags & 3];
    if (!USER_ID.test(id) || !mine) return null;
    list.set(id, {
      mine,
      mineAt: getTime(bytes, at + ID_LEN + 1),
      theirs: (flags & 4) !== 0,
      theirsAt: getTime(bytes, at + ID_LEN + 7),
      sentAt: getTime(bytes, at + ID_LEN + 13),
    });
  }
  return list;
}

export interface FriendsView {
  friends: string[];
  incoming: string[];
  outgoing: string[];
  blocked: string[];
}

/** What the app shows. `gone` are deleted accounts: no longer friends, and they can't answer. */
export function friendsView(list: FriendList, gone: Set<string>): FriendsView {
  const view: FriendsView = { friends: [], incoming: [], outgoing: [], blocked: [] };
  for (const [id, e] of list) {
    if (e.mine === 'blocked') view.blocked.push(id);
    else if (gone.has(id)) continue;
    else if (e.mine === 'listed') (e.theirs ? view.friends : view.outgoing).push(id);
    else if (e.theirs) view.incoming.push(id);
  }
  return view;
}
