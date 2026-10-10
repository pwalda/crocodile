import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecureStore, type Keychain } from '../apps/desktop/src/main/secure-store';

/** A keychain that "encrypts" by reversing, and can be locked. */
function keychain() {
  const k = {
    locked: false,
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from([...v].reverse().join('')),
    decryptString: (b: Buffer) => {
      if (k.locked) throw new Error('Error while decrypting the ciphertext provided');
      return [...b.toString()].reverse().join('');
    },
  };
  return k satisfies Keychain;
}

describe('secure storage', () => {
  it('reports a locked keychain as an error, never as a missing value', () => {
    const k = keychain();
    const store = new SecureStore(join(mkdtempSync(join(tmpdir(), 'croc-')), 'secure.json'), k);
    expect(store.get('local-data-key')).toBeUndefined();
    store.set('local-data-key', 'the key');
    expect(store.get('local-data-key')).toBe('the key');
    // Locked (or not started yet): the value is there but can't be opened.
    k.locked = true;
    expect(() => store.get('local-data-key')).toThrow(/KEYCHAIN_LOCKED/);
    k.locked = false;
    expect(store.get('local-data-key')).toBe('the key');
  });
});
