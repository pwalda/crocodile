import { describe, expect, it } from 'vitest';
import { chunkByBytes, withinBytes } from '../src/util';

describe('chunkByBytes', () => {
  const items = Array.from({ length: 10 }, (_, i) => 'x'.repeat(100 + i));

  it('keeps every run within the budget and the order intact', () => {
    const chunks = chunkByBytes(items, 350);
    expect(chunks.flat()).toEqual(items);
    for (const c of chunks) expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThanOrEqual(350);
  });

  it('caps the count too, and sends an oversized item alone', () => {
    expect(chunkByBytes(items, 1e9, 4).map((c) => c.length)).toEqual([4, 4, 2]);
    expect(chunkByBytes(['y'.repeat(500), 'z'], 100)).toEqual([['y'.repeat(500)], ['z']]);
  });

  it('withinBytes takes the leading run that fits', () => {
    expect(withinBytes(items, 250)).toEqual(items.slice(0, 2));
    expect(withinBytes([], 250)).toEqual([]);
  });
});
