import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import {
  SIG_DOMAIN,
  concatBytes,
  fromB64u,
  peerIds,
  toB64u,
  type LinkBox,
  type PrekeyBundle,
  type SealedBox,
} from '@crocodile/protocol';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdfSha256,
  randomBytes,
  verifyPayload,
  x25519,
} from './primitives';
import { decodeEncKey, keyMatchesUserId, sign, type Identity } from './identity';
import { pad, unpad } from './padding';
import { prekeySecrets, type PrekeySecret } from './prekeys';

/**
 * Hybrid post-quantum sealed box to one device:
 *
 *   ss = X25519(ephemeral, prekey.x25519) ‖ ML-KEM-768.encaps(prekey.mlkem)
 *   key, nonce = HKDF-SHA256(ss, salt = epk ‖ kem ‖ prekey ids)
 *   ct = AES-256-GCM(key, nonce, pad(plaintext))
 *   sig = Ed25519(sender, everything above + recipient)
 *
 * Breaking it needs both X25519 and ML-KEM broken ("harvest now, decrypt
 * later" resistant); prekeys rotate weekly and their secrets are deleted, so
 * old boxes stay sealed even if a device is later compromised.
 */
function boxKey(
  ssX: Uint8Array,
  ssKem: Uint8Array,
  epk: Uint8Array,
  kem: Uint8Array,
  to: string,
  pk: number,
) {
  const salt = concatBytes(epk, kem, new TextEncoder().encode(`${to}|${pk}`));
  const okm = hkdfSha256(concatBytes(ssX, ssKem), salt, SIG_DOMAIN.sealed, 44);
  return { key: okm.slice(0, 32), nonce: okm.slice(32, 44) };
}

function signedPart(box: Omit<SealedBox, 'sig'>, recipientX25519: string) {
  return {
    v: box.v,
    to: box.to,
    pk: box.pk,
    epk: box.epk,
    kem: box.kem,
    ct: box.ct,
    from: box.from,
    fromDevice: box.fromDevice,
    rx: recipientX25519,
  };
}

export function sealToDevice(
  sender: Identity,
  senderDevice: string,
  recipient: { peer: string; prekey: PrekeyBundle },
  plaintext: Uint8Array,
): SealedBox {
  const ephSecret = randomBytes(32);
  const epk = x25519.getPublicKey(ephSecret);
  const ssX = x25519.getSharedSecret(ephSecret, fromB64u(recipient.prekey.x25519));
  const { cipherText: kem, sharedSecret: ssKem } = ml_kem768.encapsulate(
    fromB64u(recipient.prekey.mlkem),
  );
  const { key, nonce } = boxKey(ssX, ssKem, epk, kem, recipient.peer, recipient.prekey.id);
  const ct = aesGcmEncrypt(key, nonce, pad(plaintext));
  const unsigned = {
    v: 2 as const,
    to: recipient.peer,
    pk: recipient.prekey.id,
    epk: toB64u(epk),
    kem: toB64u(kem),
    ct: toB64u(ct),
    from: sender.publicKey,
    fromDevice: senderDevice,
  };
  return {
    ...unsigned,
    sig: sign(sender, SIG_DOMAIN.sealed, signedPart(unsigned, recipient.prekey.x25519)),
  };
}

export interface OpenedBox {
  /** Verified sender peer id. */
  from: string;
  fromUser: string;
  fromKey: string;
  plaintext: Uint8Array;
}

export function openSealed(
  me: { peer: string },
  prekeys: (id: number) => PrekeySecret | undefined,
  box: SealedBox,
  fromUserId: (key: string) => string,
): OpenedBox | null {
  if (box.to !== me.peer) return null;
  const pk = prekeys(box.pk);
  if (!pk) return null;
  if (!verifyPayload(box.from, SIG_DOMAIN.sealed, signedPart(box, pk.bundle.x25519), box.sig))
    return null;
  try {
    const secrets = prekeySecrets(pk);
    const epk = fromB64u(box.epk);
    const kem = fromB64u(box.kem);
    const ssX = x25519.getSharedSecret(secrets.x25519, epk);
    const ssKem = ml_kem768.decapsulate(kem, secrets.mlkem);
    const { key, nonce } = boxKey(ssX, ssKem, epk, kem, box.to, box.pk);
    const padded = aesGcmDecrypt(key, nonce, fromB64u(box.ct));
    const plaintext = padded && unpad(padded);
    if (!plaintext) return null;
    const fromUser = fromUserId(box.from);
    return { from: peerIds.make(fromUser, box.fromDevice), fromUser, fromKey: box.from, plaintext };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Device linking: the account seed sealed to a new device's temporary
// identity (X25519, ephemeral-static, signed by the account key).
// ---------------------------------------------------------------------------

export function sealLink(
  sender: Identity,
  recipientEncKey: string,
  plaintext: Uint8Array,
): LinkBox {
  const recipient = decodeEncKey(recipientEncKey);
  const eph = randomBytes(32);
  const epk = x25519.getPublicKey(eph);
  const okm = hkdfSha256(
    x25519.getSharedSecret(eph, recipient),
    concatBytes(epk, recipient),
    'croc/v1/link',
    44,
  );
  const ct = aesGcmEncrypt(okm.slice(0, 32), okm.slice(32), plaintext);
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
    sig: sign(sender, 'croc/v1/link', unsigned),
  };
}

export function openLink(
  recipient: Identity,
  box: LinkBox,
  expectedUserId: string,
): Uint8Array | null {
  if (!keyMatchesUserId(box.from, expectedUserId)) return null;
  const unsigned = { epk: box.epk, ct: box.ct, from: box.from, to: recipient.encPublicKey };
  if (!verifyPayload(box.from, 'croc/v1/link', unsigned, box.sig)) return null;
  try {
    const epk = fromB64u(box.epk);
    const own = decodeEncKey(recipient.encPublicKey);
    const okm = hkdfSha256(
      x25519.getSharedSecret(recipient.encSecret, epk),
      concatBytes(epk, own),
      'croc/v1/link',
      44,
    );
    return aesGcmDecrypt(okm.slice(0, 32), okm.slice(32), fromB64u(box.ct));
  } catch {
    return null;
  }
}
