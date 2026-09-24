import { describe, expect, it } from 'vitest';
import { SlotTable, StreamRewriter, SPEECH_HANGOVER_MS } from '../src';

describe('SlotTable', () => {
  it('fills free slots, then evicts the longest-quiet speaker past the hangover', () => {
    const t = new SlotTable(2);
    const loud = new Map<string, number>();
    const last = (id: string) => loud.get(id) ?? 0;
    loud.set('a', 1000).set('b', 1000);
    expect(t.assign('a', 1000, last)).toBe(0);
    expect(t.assign('b', 1000, last)).toBe(1);
    loud.set('c', 1100);
    expect(t.assign('c', 1100, last)).toBe(-1);
    loud.set('b', 1200);
    const later = 1000 + SPEECH_HANGOVER_MS + 50;
    expect(t.assign('c', later, last)).toBe(0);
    expect(t.slots).toEqual(['c', 'b']);
    expect(t.release('b')).toBe(true);
    expect(t.slots).toEqual(['c', null]);
  });
});

describe('StreamRewriter', () => {
  it('keeps sequence numbers contiguous across source switches', () => {
    const r = new StreamRewriter();
    const a1 = r.rewrite('a', 100, 5000, 0);
    const a2 = r.rewrite('a', 101, 5960, 20);
    expect(a2.seq).toBe((a1.seq + 1) & 0xffff);
    expect(a2.ts).toBe((a1.ts + 960) >>> 0);
    expect(a1.marker).toBe(true);
    expect(a2.marker).toBe(false);
    const b1 = r.rewrite('b', 60000, 123, 1020);
    expect(b1.seq).toBe((a2.seq + 1) & 0xffff);
    expect(b1.marker).toBe(true);
    // One second of silence between speakers is reflected in the timestamp.
    expect((b1.ts - a2.ts) >>> 0).toBe(48_000);
  });
});
