/**
 * Utility process running an embedded coordination server, for users who opt
 * in to contributing one to the mesh (or want a private LAN server).
 */
import type { CoordinatorProcessIn, CoordinatorProcessOut } from './ipc-types';
import { createCoordinatorHost } from './coordinator-host';

const port = (
  process as unknown as {
    parentPort: {
      on(ev: 'message', fn: (e: { data: CoordinatorProcessIn }) => void): void;
      postMessage(m: CoordinatorProcessOut): void;
    };
  }
).parentPort;

const host = createCoordinatorHost((status) => port.postMessage({ type: 'status', status }));
setInterval(() => host.refresh(), 5000).unref();
port.on('message', ({ data: msg }) => void host.send(msg));
