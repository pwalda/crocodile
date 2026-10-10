import { describe, expect, it } from 'vitest';
import { GroupKeyring, VoiceEngine } from '../src';

describe('voice frame keys', () => {
  it('each new connection encrypts under an audio key no earlier sender used', () => {
    const posted: { type: string; scope?: string; keys?: { mine: { gen: number } | null } }[] = [];
    const worker = { postMessage: (m: never) => posted.push(m) } as unknown as Worker;
    const engine = new VoiceEngine({
      getUserMedia: async () => {
        throw new Error('no microphone here');
      },
      createFrameWorker: () => worker,
    });
    const keyring = new GroupKeyring({ autoRatchet: false });
    // Two connections, one after the other (a reconnect).
    engine.frameCrypto(keyring);
    engine.frameCrypto(keyring);
    const gens = posted
      .filter((m) => m.type === 'keys')
      .map((m) => ({ scope: m.scope, gen: m.keys!.mine!.gen }));
    const first = gens.find((g) => g.scope === gens[0]!.scope)!.gen;
    const second = gens.find((g) => g.scope !== gens[0]!.scope)!.gen;
    expect(second).toBeGreaterThan(first);
    keyring.dispose();
  });
});
