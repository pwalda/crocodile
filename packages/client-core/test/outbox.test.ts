import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@crocodile/protocol';
import { MemoryKeyValueStore } from '../src/platform';
import { Outbox } from '../src/outbox';

const message = (id: string, ch: string) => ({ id, ch, ts: Date.now() }) as unknown as ChatMessage;

describe('outbox', () => {
  it('clears only what was confirmed in the session it was written for', () => {
    const outbox = new Outbox(new MemoryKeyValueStore());
    outbox.add(message('mine-in-dm', 'dm:a:b'), 'dm:a:b');
    outbox.add(message('mine-in-space', 'general'), 'space:abcdefghij');
    // A confirmation from another conversation names ids it has no business with.
    expect(outbox.ack('space:abcdefghij', ['mine-in-dm', 'unknown'])).toEqual([]);
    expect(outbox.has('mine-in-dm')).toBe(true);
    expect(outbox.ack('dm:a:b', ['mine-in-dm', 'mine-in-space'])).toEqual(['mine-in-dm']);
    expect(outbox.has('mine-in-dm')).toBe(false);
    expect(outbox.has('mine-in-space')).toBe(true);
  });
});
