import { describe, expect, it, vi } from 'vitest';
import { utf8 } from '@crocodile/protocol';
import { createSenderKey, encryptText, exportChains, importChain, TextReceiver } from '../src';
import * as primitives from '../src/primitives';

vi.mock('../src/primitives', async (original) => {
  const real = await original<typeof import('../src/primitives')>();
  return { ...real, hkdfSha256: vi.fn(real.hkdfSha256) };
});

const derivations = () => vi.mocked(primitives.hkdfSha256).mock.calls.length;

describe('a text receiver given a message that does not open', () => {
  it('works out what a made-up generation skips once, however many it sends', () => {
    const sk = createSenderKey();
    const rx = new TextReceiver(sk.kid, importChain(exportChains(sk).text));
    const real = encryptText(sk, utf8.encode('hello'));
    // The first, two thousand ahead, goes the whole way: a step for each generation.
    const start = derivations();
    expect(rx.decrypt(real.g + 2000, real.ct)).toBeNull();
    expect(derivations() - start).toBeLessThanOrEqual(2000 + 2);
    // The same again, and a little further on, and nearer: a few steps from a place kept.
    const again = derivations();
    for (let i = 0; i < 50; i++) expect(rx.decrypt(real.g + 2000, real.ct)).toBeNull();
    expect(rx.decrypt(real.g + 2001, real.ct)).toBeNull();
    expect(rx.decrypt(real.g + 1000, real.ct)).toBeNull();
    expect(rx.decrypt(real.g + 10, real.ct)).toBeNull();
    // (Each a key for the generation and up to 15 steps to it, not 2,000.)
    expect(derivations() - again).toBeLessThanOrEqual(53 * 17);
    // Past the limit is refused without any work.
    const refused = derivations();
    expect(rx.decrypt(real.g + 2002, real.ct)).toBeNull();
    expect(derivations()).toBe(refused);
    expect(rx.gen).toBe(0);
    // What is kept to make that cheap is bounded: one place in sixteen, over what can be skipped.
    const kept = (rx as unknown as { checkpoints: Map<number, unknown> }).checkpoints;
    expect(kept.size).toBeLessThanOrEqual(2000 / 16 + 1);
  });

  it('still opens what is real, in any order, after it has been asked for the same', () => {
    const sk = createSenderKey();
    const rx = new TextReceiver(sk.kid, importChain(exportChains(sk).text));
    const sent = Array.from({ length: 304 }, (_, i) => encryptText(sk, utf8.encode(`m${i}`)));
    const last = sent[303]!;
    // Warmed by a message that is not real, then by one that is: the cache is not what is kept.
    expect(rx.decrypt(last.g, sent[0]!.ct)).toBeNull();
    expect(rx.decrypt(last.g + 100, last.ct)).toBeNull();
    expect(utf8.decode(rx.decrypt(last.g, last.ct)!)).toBe('m303');
    expect(rx.gen).toBe(304);
    // Nothing is kept at or before where the chain is now (304 is a place that is kept).
    const kept = (rx as unknown as { checkpoints: Map<number, unknown> }).checkpoints;
    expect([...kept.keys()].every((at) => at > rx.gen)).toBe(true);
    // Those before it that are still kept open once each (the most that are kept is 256).
    expect(utf8.decode(rx.decrypt(sent[100]!.g, sent[100]!.ct)!)).toBe('m100');
    expect(rx.decrypt(sent[100]!.g, sent[100]!.ct)).toBeNull();
    expect(rx.decrypt(sent[10]!.g, sent[10]!.ct)).toBeNull();
    // And the chain goes on from where it was.
    const next = encryptText(sk, utf8.encode('next'));
    expect(utf8.decode(rx.decrypt(next.g, next.ct)!)).toBe('next');
  });

  it('opens a message that is some way ahead when it was warmed past it', () => {
    const sk = createSenderKey();
    const rx = new TextReceiver(sk.kid, importChain(exportChains(sk).text));
    const sent = Array.from({ length: 40 }, (_, i) => encryptText(sk, utf8.encode(`m${i}`)));
    expect(rx.decrypt(sent[39]!.g + 500, sent[0]!.ct)).toBeNull();
    // From the middle: the ones it skipped open afterwards, and those after it, from what was kept.
    expect(utf8.decode(rx.decrypt(sent[20]!.g, sent[20]!.ct)!)).toBe('m20');
    expect(utf8.decode(rx.decrypt(sent[5]!.g, sent[5]!.ct)!)).toBe('m5');
    expect(utf8.decode(rx.decrypt(sent[39]!.g, sent[39]!.ct)!)).toBe('m39');
    expect(utf8.decode(rx.decrypt(sent[21]!.g, sent[21]!.ct)!)).toBe('m21');
  });

  it('refuses a generation that is not a whole number', () => {
    const sk = createSenderKey();
    const rx = new TextReceiver(sk.kid, importChain(exportChains(sk).text));
    const real = encryptText(sk, utf8.encode('x'));
    for (const g of [0.5, Number.NaN, Infinity, -Infinity, 2 ** 60])
      expect(rx.decrypt(g, real.ct)).toBeNull();
    expect(utf8.decode(rx.decrypt(real.g, real.ct)!)).toBe('x');
  });
});
