import { describe, expect, it } from 'vitest';
import { chunkByBytes, numberOption, withinBytes } from '../src/util';

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

describe('numberOption', () => {
  it('reads numbers, and falls back when unset', () => {
    expect(numberOption(undefined, '--port', 7443)).toBe(7443);
    expect(numberOption(' ', '--port', 7443)).toBe(7443);
    expect(numberOption('8080', '--port', 7443, { min: 0, max: 65535 })).toBe(8080);
    expect(numberOption('0.5', '--mailbox-days', 3, { min: 0.01, integer: false })).toBe(0.5);
  });

  it('refuses what would become NaN or fall out of range', () => {
    expect(() => numberOption('three', '--mailbox-days', 3, { integer: false })).toThrow(
      '--mailbox-days must be a number, not "three"',
    );
    expect(() => numberOption('-1', '--mailbox-days', 3, { min: 0.01, integer: false })).toThrow(
      /at least 0.01/,
    );
    expect(() => numberOption('1.5', '--replicas', 3, { min: 1 })).toThrow(/whole number/);
    expect(() => numberOption('70000', '--port', 7443, { max: 65535 })).toThrow(/at most 65535/);
  });
});
