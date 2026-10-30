import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecureStore, type Keychain } from '../apps/desktop/src/main/secure-store';

/** A keychain that "encrypts" by reversing, and can be locked. */
function keychain() {
  const k = {
    locked: false,
    available: true,
    backend: undefined as string | undefined,
    failEncrypt: false,
    isEncryptionAvailable: () => k.available,
    getSelectedStorageBackend: () => k.backend ?? 'gnome_libsecret',
    encryptString: (v: string) => {
      if (k.failEncrypt) throw new Error('keychain refused');
      return Buffer.from([...v].reverse().join(''));
    },
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

  const fileOf = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;

  it('says how well it keeps secrets', () => {
    const k = keychain();
    const store = new SecureStore(join(mkdtempSync(join(tmpdir(), 'croc-')), 'secure.json'), k);
    expect(store.protection()).toBe('keychain');
    k.backend = 'basic_text';
    expect(store.protection()).toBe('weak');
    k.backend = 'unknown';
    expect(store.protection()).toBe('weak');
    k.available = false;
    expect(store.protection()).toBe('none');
  });

  it('moves what was stored plainly into the keychain once there is one', () => {
    const k = keychain();
    const path = join(mkdtempSync(join(tmpdir(), 'croc-')), 'secure.json');
    const store = new SecureStore(path, k);
    k.available = false;
    store.set('identity-seed', 'the seed');
    store.set('local-data-key', 'the key');
    expect(fileOf(path)['identity-seed']).toBe('raw:the seed');
    expect(store.upgrade()).toBe(0);
    expect(fileOf(path)['identity-seed']).toBe('raw:the seed');

    k.available = true;
    expect(store.upgrade()).toBe(2);
    expect(fileOf(path)['identity-seed']).toMatch(/^enc:/);
    expect(readFileSync(path, 'utf8')).not.toContain('the seed');
    expect(store.get('identity-seed')).toBe('the seed');
    expect(store.get('local-data-key')).toBe('the key');
    expect(store.upgrade()).toBe(0);
  });

  it('does not move it into a keychain whose key is public, nor lose it when that fails', () => {
    const k = keychain();
    const path = join(mkdtempSync(join(tmpdir(), 'croc-')), 'secure.json');
    const store = new SecureStore(path, k);
    k.available = false;
    store.set('identity-seed', 'the seed');
    k.available = true;
    k.backend = 'basic_text';
    expect(store.upgrade()).toBe(0);
    expect(fileOf(path)['identity-seed']).toBe('raw:the seed');

    k.backend = undefined;
    k.failEncrypt = true;
    expect(store.upgrade()).toBe(0);
    expect(store.get('identity-seed')).toBe('the seed');
    k.failEncrypt = false;
    expect(store.upgrade()).toBe(1);
  });

  it('keeps going when the moved values cannot be written, and ignores what is not text', () => {
    const k = keychain();
    const dir = mkdtempSync(join(tmpdir(), 'croc-'));
    const path = join(dir, 'secure.json');
    writeFileSync(path, JSON.stringify({ 'identity-seed': 'raw:the seed', odd: 42, nested: {} }));
    const store = new SecureStore(path, k);
    // The folder can't take the new file: the old one stays, and nothing throws.
    mkdirSync(`${path}.tmp`);
    expect(store.upgrade()).toBe(0);
    expect(store.get('identity-seed')).toBe('the seed');
    expect(store.get('odd')).toBeUndefined();
    rmSync(`${path}.tmp`, { recursive: true });
    expect(store.upgrade()).toBe(1);
    expect(store.get('identity-seed')).toBe('the seed');
  });
});
