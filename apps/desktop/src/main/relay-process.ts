/**
 * Utility process that runs host relays (one per session this device hosts).
 * Kept out of the main process so media forwarding never stalls the UI.
 */
import { HostRelay } from '@crocodile/relay';
import { identityFromSeed } from '@crocodile/crypto';
import { fromB64u } from '@crocodile/protocol';
import type { RelayProcessIn, RelayProcessOut } from './ipc-types';

const port = (
  process as unknown as {
    parentPort: {
      on(ev: 'message', fn: (e: { data: RelayProcessIn }) => void): void;
      postMessage(m: RelayProcessOut): void;
    };
  }
).parentPort;
const relays = new Map<string, { relay: HostRelay; members: Set<string> }>();
const send = (m: RelayProcessOut) => port.postMessage(m);

port.on('message', ({ data: msg }) => {
  switch (msg.type) {
    case 'start': {
      const entry = { members: new Set<string>(), relay: undefined as unknown as HostRelay };
      try {
        entry.relay = new HostRelay({
          sessionId: msg.sessionId,
          epoch: msg.epoch,
          identity: identityFromSeed(fromB64u(msg.seed)),
          hostPeer: msg.hostPeer,
          slots: msg.slots,
          iceServers: msg.iceServers,
          // Lets this device's own client reach its relay over loopback.
          includeLoopback: true,
          admit: (userId) => entry.members.has(userId),
          sendSignal: (to, data) => send({ type: 'signal', handle: msg.handle, to, data }),
          log: {
            info: (m, extra) => send({ type: 'log', level: 'info', msg: m, extra }),
            warn: (m, extra) => send({ type: 'log', level: 'warn', msg: m, extra }),
          },
        });
        relays.set(msg.handle, entry);
        send({ type: 'started', handle: msg.handle });
      } catch (err) {
        send({ type: 'error', handle: msg.handle, message: String(err) });
      }
      return;
    }
    case 'members': {
      const e = relays.get(msg.handle);
      if (e) e.members = new Set(msg.members);
      return;
    }
    case 'signal':
      void relays.get(msg.handle)?.relay.handleSignal(msg.from, msg.data);
      return;
    case 'close': {
      const e = relays.get(msg.handle);
      relays.delete(msg.handle);
      void e?.relay.close();
      return;
    }
  }
});
