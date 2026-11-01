import { describe, expect, it } from 'vitest';
import { FedFrameSchema, RpcParams, canonicalJson, sessionOpPayload } from '../src';

const caps = { canHost: true, platform: 'desktop', nat: 'open' } as const;
const proof = {
  server: 'server-one',
  at: 1_700_000_000_000,
  since: 1_699_999_990_000,
  n: 2,
  sig: 'c2ln',
};
const peer = 'abcdefghij.klmnopqrst';
const sessionId = 'space:abcdefgh';

describe('session operation proofs', () => {
  it('travel with the operation, between servers and from the client', () => {
    const fed = FedFrameSchema.safeParse({
      t: 'session_op',
      opId: 'x',
      sessionId,
      peer,
      op: { op: 'update', caps },
      proof,
    });
    expect(fed.success && fed.data.t === 'session_op' && fed.data.proof).toEqual(proof);
    expect(RpcParams['session.join'].safeParse({ sessionId, caps, proof }).data?.proof).toEqual(
      proof,
    );
    expect(RpcParams['session.update'].safeParse({ sessionId, caps, proof }).data?.proof).toEqual(
      proof,
    );
    expect(
      RpcParams['session.report'].safeParse({
        sessionId,
        epoch: 1,
        issue: 'host_unreachable',
        proof,
      }).data?.proof,
    ).toEqual(proof);
  });

  it('are optional in the frame, so an unsigned one is told so rather than not understood', () => {
    expect(
      FedFrameSchema.safeParse({ t: 'session_op', opId: 'x', sessionId, peer, op: { op: 'leave' } })
        .success,
    ).toBe(true);
    expect(RpcParams['session.join'].safeParse({ sessionId, caps }).success).toBe(true);
  });

  it('carry the hint of a join, with an epoch that is a number a signature can be made over', () => {
    const hint = { epoch: 7, host: peer, backup: null };
    expect(RpcParams['session.join'].safeParse({ sessionId, caps, hint }).data?.hint).toEqual(hint);
    const op = { op: 'join', caps, hint };
    const frame = (o: unknown) =>
      FedFrameSchema.safeParse({ t: 'session_op', opId: 'x', sessionId, peer, op: o }).success;
    expect(frame(op)).toBe(true);
    for (const epoch of [1e300, 2 ** 53, 1.5]) {
      const bad = { epoch, host: peer, backup: null };
      expect(RpcParams['session.join'].safeParse({ sessionId, caps, hint: bad }).success).toBe(
        false,
      );
      expect(frame({ op: 'join', caps, hint: bad })).toBe(false);
    }
  });

  it('are bounded', () => {
    for (const bad of [
      { ...proof, sig: 'x'.repeat(201) },
      { ...proof, server: 'x'.repeat(201) },
      { ...proof, n: -1 },
      { ...proof, n: 2 ** 31 + 1 },
      { ...proof, at: Number.MAX_SAFE_INTEGER + 2 },
      { ...proof, since: 1e300 },
      { ...proof, at: -1 },
      { ...proof, at: 1.5 },
      { ...proof, since: 'now' },
      { server: 'server-one', at: 1 },
      { ...proof, server: '' },
      { ...proof, sig: '' },
    ])
      expect(RpcParams['session.join'].safeParse({ sessionId, caps, proof: bad }).success).toBe(
        false,
      );
  });

  it('name what is signed the same whether a claim is left out or undefined', () => {
    const a = sessionOpPayload(sessionId, peer, { op: 'join', caps }, proof);
    const b = sessionOpPayload(
      sessionId,
      peer,
      { op: 'join', caps: { ...caps, rttMs: undefined } },
      proof,
    );
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(
      sessionOpPayload(sessionId, peer, { op: 'join', caps }, { server: 's', at: 1 }),
    ).toMatchObject({
      since: null,
      n: null,
    });
  });

  it('bound the epoch of a report', () => {
    for (const epoch of [-1, 1e300, 1.5])
      expect(
        RpcParams['session.report'].safeParse({
          sessionId,
          epoch,
          issue: 'host_unreachable',
          proof,
        }).success,
      ).toBe(false);
    expect(
      FedFrameSchema.safeParse({
        t: 'session_op',
        opId: 'x',
        sessionId,
        peer,
        op: { op: 'report', epoch: 1e300, issue: 'host_unreachable' },
        proof,
      }).success,
    ).toBe(false);
  });

  it('keep a join whose hint has no epoch worth the name, for the owner to leave the hint out', () => {
    for (const epoch of [-1, 2 ** 40])
      expect(
        FedFrameSchema.safeParse({
          t: 'session_op',
          opId: 'x',
          sessionId,
          peer,
          op: { op: 'join', caps, hint: { epoch, host: null, backup: null } },
        }).success,
      ).toBe(true);
  });
});
