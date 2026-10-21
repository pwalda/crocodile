import { randomId, verifyMailProof } from '@crocodile/crypto';
import {
  peerIds,
  recordKey,
  type MailItem,
  type MailProof,
  type SealedBox,
} from '@crocodile/protocol';
import type { ClientConnection } from './client';
import type { Coordinator } from './coordinator';
import type { StoredMail } from './store';
import { RpcFailure } from './util';

/** Upper bound on how long any server holds mail (matches prekey retention). */
export const MAILBOX_MAX_TTL_MS = 7 * 24 * 3600_000;
const MAX_BOX_CHARS = 96 * 1024;
const BATCH = 50;

export interface MailboxConfig {
  enabled: boolean;
  /** How long items are kept (capped at MAILBOX_MAX_TTL_MS). */
  ttlMs: number;
  maxPerRecipient: number;
  maxPerSender: number;
  maxTotal: number;
}

export const defaultMailboxConfig: MailboxConfig = {
  enabled: true,
  ttlMs: 3 * 24 * 3600_000,
  maxPerRecipient: 1000,
  maxPerSender: 2000,
  maxTotal: 200_000,
};

/**
 * Opt-in store-and-forward for offline devices. Clients deposit boxes sealed
 * (hybrid post-quantum) to a recipient device's prekey; the server keeps them
 * until that device connects anywhere in the mesh, acknowledges them, or the
 * TTL passes. The server never sees content, only sender, recipient, size and
 * time.
 */
export class MailboxService {
  private timer: ReturnType<typeof setInterval>;

  constructor(private readonly hub: Coordinator) {
    this.timer = setInterval(() => this.expire(), 60_000);
    this.timer.unref?.();
  }

  get config(): MailboxConfig {
    return this.hub.config.mailbox;
  }

  get ttlMs() {
    return Math.min(this.config.ttlMs, MAILBOX_MAX_TTL_MS);
  }

  async put(client: ClientConnection, items: { to: string; box: SealedBox }[]) {
    if (!this.config.enabled)
      throw new RpcFailure('unavailable', 'this server does not keep mail for offline devices');
    const store = this.hub.store;
    if (store.mailCount({}) + items.length > this.config.maxTotal)
      throw new RpcFailure('unavailable', 'the mailbox on this server is full');
    if (store.mailCount({ from: client.userId }) + items.length > this.config.maxPerSender)
      throw new RpcFailure('rate_limited', 'you have too much undelivered mail on this server');
    // The recipients' device records may live on other servers.
    const devices = new Map(
      (
        await this.hub.dist.get(
          items.map(({ to }) => recordKey.device(peerIds.user(to), peerIds.device(to))),
        )
      ).map((r) => [r.key, r]),
    );
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    const stored: StoredMail[] = [];
    for (const { to, box } of items) {
      if (box.to !== to || box.from !== client.publicKey || box.fromDevice !== client.deviceId)
        throw new RpcFailure('bad_request', 'box does not match its sender or recipient');
      const toUser = peerIds.user(to);
      const device = devices.get(recordKey.device(toUser, peerIds.device(to)));
      if (!device || (device.body as { revoked?: boolean }).revoked)
        throw new RpcFailure('not_found', 'unknown recipient device');
      const json = JSON.stringify(box);
      if (json.length > MAX_BOX_CHARS) throw new RpcFailure('bad_request', 'mail item too large');
      if (store.mailCount({ toUser }) >= this.config.maxPerRecipient)
        throw new RpcFailure('unavailable', 'the recipient has too much undelivered mail');
      stored.push({
        id: randomId(10),
        to,
        toUser,
        from: client.userId,
        box: json,
        createdAt: now,
        expiresAt,
      });
    }
    for (const m of stored) store.mailPut(m);
    this.hub.log.debug('mail stored', { from: client.userId, count: stored.length });
    for (const to of new Set(stored.map((m) => m.to))) this.deliverTo(to);
    return { ids: stored.map((m) => m.id), expiresAt };
  }

  /** Push what we hold for a device to wherever it is connected. */
  deliverTo(peer: string, viaServer?: string) {
    const items = this.hub.store.mailFor(peer, Date.now(), BATCH);
    if (items.length === 0) return;
    const d = { items: items.map(toWire) };
    if (viaServer) this.hub.mesh.sendTo(viaServer, { t: 'route', to: peer, ev: 'mail', d });
    else this.hub.deliverToPeer(peer, 'mail', d);
  }

  /**
   * A device is ready for its mail: send ours, and ask the mesh for theirs.
   * Other servers send theirs only with the device's signature naming this
   * server (`proof`), so no server can ask for someone else's mail.
   */
  fetch(client: ClientConnection, proof?: MailProof) {
    this.deliverTo(client.peer);
    if (proof) this.hub.mesh.flood({ t: 'mail_query', peer: client.peer, proof });
  }

  onQuery(fromServer: string, peer: string, proof?: MailProof) {
    if (!verifyMailProof(peer, { t: 'mail_fetch', peer, server: fromServer }, proof)) return;
    this.deliverTo(peer, fromServer);
  }

  ack(client: ClientConnection, ids: string[], proof?: MailProof) {
    this.hub.store.mailDelete(client.peer, ids);
    // Other servers delete only with the device's signature on these ids.
    if (proof) this.hub.mesh.flood({ t: 'mail_ack', peer: client.peer, ids, proof });
    this.deliverTo(client.peer);
  }

  onRemoteAck(peer: string, ids: string[], proof?: MailProof) {
    if (!verifyMailProof(peer, { t: 'mail_ack', peer, ids }, proof)) return;
    if (this.hub.store.mailDelete(peer, ids) > 0) this.deliverTo(peer);
  }

  private expire() {
    const n = this.hub.store.mailExpire(Date.now());
    if (n) this.hub.log.info('mail expired', { count: n });
  }

  close() {
    clearInterval(this.timer);
  }
}

function toWire(m: StoredMail): MailItem {
  return { id: m.id, from: m.from, box: JSON.parse(m.box) as SealedBox, createdAt: m.createdAt };
}
