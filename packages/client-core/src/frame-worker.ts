/// <reference lib="webworker" />
/**
 * Voice frame encryption worker. Runs inside Chromium's encoded-transform
 * pipeline: every Opus frame leaving the microphone is encrypted with our
 * sender key before packetisation, and every frame arriving on a speaker slot
 * is decrypted with the sending member's key. The host relay only ever sees
 * ciphertext. Frames we cannot encrypt or authenticate are dropped, never
 * passed through in the clear.
 */
import {
  decryptFrame,
  deriveSenderKey,
  encryptFrame,
  importSenderKey,
  peekFrameKid,
  type DerivedSenderKey,
} from '@crocodile/crypto';
import type { FrameKeys } from './keyring';

interface Scope {
  mine: { derived: DerivedSenderKey; counter: number } | null;
  peers: Map<number, DerivedSenderKey>;
}

const scopes = new Map<string, Scope>();
const derivedCache = new Map<string, DerivedSenderKey>();

function derive(kid: number, secret: string) {
  const cacheKey = `${kid}:${secret}`;
  let d = derivedCache.get(cacheKey);
  if (!d) {
    d = deriveSenderKey(importSenderKey(kid, secret));
    derivedCache.set(cacheKey, d);
    if (derivedCache.size > 512) derivedCache.delete(derivedCache.keys().next().value!);
  }
  return d;
}

function scope(id: string): Scope {
  let s = scopes.get(id);
  if (!s) scopes.set(id, (s = { mine: null, peers: new Map() }));
  return s;
}

function updateKeys(id: string, keys: FrameKeys) {
  const s = scope(id);
  if (keys.mine && s.mine?.derived.kid !== keys.mine.kid) {
    s.mine = { derived: derive(keys.mine.kid, keys.mine.secret), counter: 0 };
  }
  s.peers = new Map(keys.peers.map((p) => [p.kid >>> 0, derive(p.kid, p.secret)]));
}

interface EncodedFrame {
  data: ArrayBuffer;
}

function pipe(readable: ReadableStream<EncodedFrame>, writable: WritableStream<EncodedFrame>, role: string, scopeId: string) {
  const transform = new TransformStream<EncodedFrame, EncodedFrame>({
    transform(frame, controller) {
      const s = scopes.get(scopeId);
      const data = new Uint8Array(frame.data);
      if (role === 'encrypt') {
        if (!s?.mine) return;
        const out = encryptFrame(s.mine.derived, s.mine.counter++, data);
        frame.data = out.slice().buffer;
        controller.enqueue(frame);
        return;
      }
      const kid = peekFrameKid(data);
      const key = kid === null ? undefined : s?.peers.get(kid);
      if (!key) return;
      const plain = decryptFrame(key, data);
      if (!plain) return;
      frame.data = plain.slice().buffer;
      controller.enqueue(frame);
    },
  });
  readable.pipeThrough(transform).pipeTo(writable).catch(() => {});
}

const ctx = self as unknown as DedicatedWorkerGlobalScope & {
  onrtctransform?: (ev: { transformer: { readable: ReadableStream; writable: WritableStream; options: { role: string; scope: string } } }) => void;
};

ctx.onmessage = (ev: MessageEvent) => {
  const m = ev.data as
    | { type: 'keys'; scope: string; keys: FrameKeys }
    | { type: 'stream'; scope: string; role: string; readable: ReadableStream; writable: WritableStream }
    | { type: 'drop'; scope: string };
  if (m.type === 'keys') updateKeys(m.scope, m.keys);
  else if (m.type === 'stream') pipe(m.readable, m.writable, m.role, m.scope);
  else if (m.type === 'drop') scopes.delete(m.scope);
};

ctx.onrtctransform = (ev) => {
  const t = ev.transformer;
  pipe(t.readable, t.writable, t.options.role, t.options.scope);
};
