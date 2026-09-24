/// <reference lib="webworker" />
/**
 * Voice frame encryption worker. Runs inside Chromium's encoded-transform
 * pipeline: every Opus frame leaving the microphone is encrypted with our
 * ratcheting sender key before packetisation, and every frame arriving on a
 * speaker slot is decrypted with the sending member's key. The host relay
 * only ever sees ciphertext. Frames we cannot encrypt or authenticate are
 * dropped, never passed through in the clear.
 */
import { AudioReceiver, AudioSender, importChain, peekFrameKid } from '@crocodile/crypto';
import type { FrameKeys } from './keyring';

interface Scope {
  sender: AudioSender | null;
  receivers: Map<number, AudioReceiver>;
}

const scopes = new Map<string, Scope>();

function scope(id: string): Scope {
  let s = scopes.get(id);
  if (!s) scopes.set(id, (s = { sender: null, receivers: new Map() }));
  return s;
}

function updateKeys(id: string, keys: FrameKeys) {
  const s = scope(id);
  if (keys.mine) {
    const chain = importChain({ gen: keys.mine.gen, key: keys.mine.key });
    if (!s.sender || s.sender.kid !== keys.mine.kid)
      s.sender = new AudioSender(keys.mine.kid, chain);
    else s.sender.update(chain);
  }
  const next = new Map<number, AudioReceiver>();
  for (const p of keys.peers) {
    const kid = p.kid >>> 0;
    // Keep receivers we already have: they may have ratcheted past the given state.
    next.set(
      kid,
      s.receivers.get(kid) ?? new AudioReceiver(kid, importChain({ gen: p.gen, key: p.key })),
    );
  }
  s.receivers = next;
}

interface EncodedFrame {
  data: ArrayBuffer;
}

function pipe(
  readable: ReadableStream<EncodedFrame>,
  writable: WritableStream<EncodedFrame>,
  role: string,
  scopeId: string,
) {
  const transform = new TransformStream<EncodedFrame, EncodedFrame>({
    transform(frame, controller) {
      const s = scopes.get(scopeId);
      const data = new Uint8Array(frame.data);
      if (role === 'encrypt') {
        if (!s?.sender) return;
        frame.data = s.sender.encrypt(data).slice().buffer;
        controller.enqueue(frame);
        return;
      }
      const kid = peekFrameKid(data);
      const receiver = kid === null ? undefined : s?.receivers.get(kid);
      const plain = receiver?.decrypt(data);
      if (!plain) return;
      frame.data = plain.slice().buffer;
      controller.enqueue(frame);
    },
  });
  readable
    .pipeThrough(transform)
    .pipeTo(writable)
    .catch(() => {});
}

const ctx = self as unknown as DedicatedWorkerGlobalScope & {
  onrtctransform?: (ev: {
    transformer: {
      readable: ReadableStream;
      writable: WritableStream;
      options: { role: string; scope: string };
    };
  }) => void;
};

ctx.onmessage = (ev: MessageEvent) => {
  const m = ev.data as
    | { type: 'keys'; scope: string; keys: FrameKeys }
    | {
        type: 'stream';
        scope: string;
        role: string;
        readable: ReadableStream;
        writable: WritableStream;
      }
    | { type: 'drop'; scope: string };
  if (m.type === 'keys') updateKeys(m.scope, m.keys);
  else if (m.type === 'stream') pipe(m.readable, m.writable, m.role, m.scope);
  else if (m.type === 'drop') scopes.delete(m.scope);
};

ctx.onrtctransform = (ev) => {
  const t = ev.transformer;
  pipe(t.readable, t.writable, t.options.role, t.options.scope);
};
