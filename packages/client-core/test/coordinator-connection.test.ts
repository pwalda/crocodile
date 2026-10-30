import { describe, expect, it } from 'vitest';
import { clockOffsetFrom } from '../src/coordinator-connection';

describe('the clock of a server', () => {
  it('is how far ahead of ours it says it is, in whole milliseconds', () => {
    expect(clockOffsetFrom(10_000, 4_000)).toBe(6_000);
    expect(clockOffsetFrom(4_000, 10_000)).toBe(-6_000);
    expect(clockOffsetFrom(10_000.6, 4_000)).toBe(6_001);
  });

  it('is not believed beyond half an hour, nor when it is no number', () => {
    const now = 1_700_000_000_000;
    expect(clockOffsetFrom(now + 3 * 3_600_000, now)).toBe(30 * 60_000);
    expect(clockOffsetFrom(now - 3 * 3_600_000, now)).toBe(-30 * 60_000);
    expect(clockOffsetFrom(Number.NaN, now)).toBe(0);
    expect(clockOffsetFrom(Number.POSITIVE_INFINITY, now)).toBe(0);
  });
});
