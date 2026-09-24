import { SIG_DOMAIN, concatBytes, fromB64u, toB64u, type SealedBox } from '@crocodile/protocol';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdfSha256,
  randomBytes,
  verifyPayload,
  x25519,
} from './primitives';
import { decodeEncKey, sign, userIdFromKey, type Identity } from './identity';

/**
 * Authenticated public-key encryption to one recipient ("signcryption"):
 * ephemeral-static X25519 → HKDF-SHA256 → AES-256-GCM, with the whole box
 * signed by the sender's Ed25519 identity. The recipient learns who sent it
 * and that it was meant for them; relays and servers learn nothing.
 */
function deriveBoxKey(shared: Uint8Array, epk: Uint8Array, recipientEnc: Uint8Array) {
  const okm = hkdfSha256(shared, concatBytes(epk, recipientEnc), SIG_DOMAIN.sealed, 44);
  return { key: okm.slice(0, 32), nonce: okm.slice(32, 44) };
}

export function seal(sender: Identity, recipientEncKey: string, plaintext: Uint8Array): SealedBox {
  const recipientEnc = decodeEncKey(recipientEncKey);
  const ephSecret = randomBytes(32);
  const epk = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, recipientEnc);
  const { key, nonce } = deriveBoxKey(shared, epk, recipientEnc);
  const ct = aesGcmEncrypt(key, nonce, plaintext);
  const unsigned = {
    epk: toB64u(epk),
    ct: toB64u(ct),
    from: sender.publicKey,
    to: recipientEncKey,
  };
  return {
    epk: unsigned.epk,
    ct: unsigned.ct,
    from: sender.publicKey,
    sig: sign(sender, SIG_DOMAIN.sealed, unsigned),
  };
}

export interface OpenedBox {
  /** userId of the verified sender. */
  from: string;
  fromKey: string;
  plaintext: Uint8Array;
}

export function openSealed(recipient: Identity, box: SealedBox): OpenedBox | null {
  const unsigned = { epk: box.epk, ct: box.ct, from: box.from, to: recipient.encPublicKey };
  if (!verifyPayload(box.from, SIG_DOMAIN.sealed, unsigned, box.sig)) return null;
  try {
    const epk = fromB64u(box.epk);
    const shared = x25519.getSharedSecret(recipient.encSecret, epk);
    const { key, nonce } = deriveBoxKey(shared, epk, decodeEncKey(recipient.encPublicKey));
    const plaintext = aesGcmDecrypt(key, nonce, fromB64u(box.ct));
    if (!plaintext) return null;
    return { from: userIdFromKey(box.from), fromKey: box.from, plaintext };
  } catch {
    return null;
  }
}
