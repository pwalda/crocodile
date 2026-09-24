import type { SignalData } from '@crocodile/protocol';

/** Messages between the main process and the relay utility process. */
export type RelayProcessIn =
  | {
      type: 'start';
      handle: string;
      seed: string;
      hostPeer: string;
      sessionId: string;
      epoch: number;
      slots: number;
      iceServers: { urls: string }[];
    }
  | { type: 'signal'; handle: string; from: string; data: SignalData }
  | { type: 'members'; handle: string; members: string[] }
  | { type: 'close'; handle: string };

export type RelayProcessOut =
  | { type: 'signal'; handle: string; to: string; data: SignalData }
  | { type: 'log'; level: 'info' | 'warn'; msg: string; extra?: Record<string, unknown> }
  | { type: 'started'; handle: string }
  | { type: 'error'; handle: string; message: string };

export interface CoordinatorSettings {
  enabled: boolean;
  name: string;
  port: number;
  publicUrl?: string;
  announce: boolean;
  /** Offer the opt-in relay (TURN) to users without a direct path. */
  relay: boolean;
  /** How many users may use the relay at once. */
  relayMaxUsers: number;
}

export type CoordinatorStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | {
      state: 'running';
      url: string;
      id: string;
      peers: number;
      users: number;
      publicUrl?: string;
      announced: boolean;
    }
  | { state: 'error'; message: string };

export type CoordinatorProcessIn =
  | { type: 'start'; settings: CoordinatorSettings; dataDir: string; directories: string[] }
  | { type: 'stop' }
  | { type: 'status' };
export type CoordinatorProcessOut = { type: 'status'; status: CoordinatorStatus };
