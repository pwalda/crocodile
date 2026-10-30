import { describe, expect, it } from 'vitest';
import { FedFrameSchema, RpcParams, SESSION_OP_SKEW_MS, sessionOpPayload } from '../src';

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
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(
      sessionOpPayload(sessionId, peer, { op: 'join', caps }, { server: 's', at: 1 }),
    ).toMatchObject({
      since: null,
      n: null,
    });
    expect(SESSION_OP_SKEW_MS).toBe(300_000);
  });
});
