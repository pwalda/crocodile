import { signSdp, verifySdp, type Identity } from '@crocodile/crypto';
import { RELAY_CHANNEL_LABEL, type ClientToRelay, type RelayToClient, type SignalData } from '@crocodile/protocol';
import { Emitter } from './emitter';

export interface FrameCryptoHooks {
  /** Install end-to-end encryption on the microphone sender. */
  protectSender(sender: RTCRtpSender): void;
  /** Install decryption on a slot receiver. */
  protectReceiver(receiver: RTCRtpReceiver): void;
  /** Extra RTCPeerConnection config needed by the hooks (legacy insertable streams). */
  rtcConfig?: Record<string, unknown>;
}

export interface RelayLinkOptions {
  RTCPeerConnection: typeof RTCPeerConnection;
  identity: Identity;
  sessionId: string;
  epoch: number;
  host: string;
  iceServers: { urls: string }[];
  slots: number;
  micTrack?: MediaStreamTrack | null;
  crypto?: FrameCryptoHooks;
  sendSignal: (data: SignalData) => Promise<unknown>;
  connectTimeoutMs?: number;
}

export type RelayLinkEvents = {
  open: void;
  message: RelayToClient;
  /** A slot's remote audio track is available. */
  track: { slot: number; track: MediaStreamTrack; receiver: RTCRtpReceiver };
  failed: { reason: string };
  closed: void;
};

/**
 * The member side of a connection to the host relay: one RTCPeerConnection
 * with the microphone upstream, `slots` downstream audio tracks and the
 * control/data channel. Trickle ICE both ways; SDP is identity-signed.
 */
export class RelayLink extends Emitter<RelayLinkEvents> {
  readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  private micSender?: RTCRtpSender;
  private remoteSet = false;
  private early: RTCIceCandidateInit[] = [];
  private closed = false;
  private opened = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: RelayLinkOptions) {
    super();
    this.pc = new opts.RTCPeerConnection({
      iceServers: opts.iceServers,
      bundlePolicy: 'max-bundle',
      ...(opts.crypto?.rtcConfig ?? {}),
    } as RTCConfiguration);
    this.dc = this.pc.createDataChannel(RELAY_CHANNEL_LABEL, { ordered: true });
    this.dc.onopen = () => {
      this.opened = true;
      clearTimeout(this.timer);
      this.emit('open', undefined);
    };
    this.dc.onclose = () => this.fail('control channel closed');
    this.dc.onmessage = (ev) => {
      try {
        this.emit('message', JSON.parse(String(ev.data)) as RelayToClient);
      } catch {
        /* ignore malformed */
      }
    };
    this.pc.onicecandidate = (ev) => {
      if (!ev.candidate || !ev.candidate.candidate) return;
      void opts
        .sendSignal({
          type: 'candidate',
          epoch: opts.epoch,
          dir: 'toRelay',
          candidate: {
            candidate: ev.candidate.candidate,
            sdpMid: ev.candidate.sdpMid ?? null,
            sdpMLineIndex: ev.candidate.sdpMLineIndex ?? null,
          },
        })
        .catch(() => {});
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed') this.fail('connection failed');
    };
    this.pc.ontrack = (ev) => {
      const transceivers = this.pc.getTransceivers();
      const index = transceivers.indexOf(ev.transceiver);
      // Transceiver 0 is our microphone; slots follow.
      if (index >= 1) this.emit('track', { slot: index - 1, track: ev.track, receiver: ev.receiver });
    };
  }

  async connect() {
    const { opts } = this;
    if (opts.slots > 0) {
      const mic = this.pc.addTransceiver(opts.micTrack ?? 'audio', { direction: 'sendonly' });
      this.micSender = mic.sender;
      opts.crypto?.protectSender(mic.sender);
      for (let i = 0; i < opts.slots; i++) {
        const t = this.pc.addTransceiver('audio', { direction: 'recvonly' });
        opts.crypto?.protectReceiver(t.receiver);
      }
    }
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.timer = setTimeout(() => this.fail('timed out connecting to host'), opts.connectTimeoutMs ?? 15_000);
    await opts.sendSignal(signSdp(opts.identity, 'offer', { sessionId: opts.sessionId, epoch: opts.epoch, to: opts.host }, this.pc.localDescription!.sdp));
  }

  async handleSignal(data: SignalData) {
    if (this.closed || data.epoch !== this.opts.epoch) return;
    if (data.type === 'answer') {
      if (!verifySdp(data, { sessionId: this.opts.sessionId, from: this.opts.host, to: this.opts.identity.userId })) {
        this.fail('host answer failed signature check');
        return;
      }
      await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      this.remoteSet = true;
      for (const c of this.early.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
    } else if (data.type === 'candidate' && data.dir === 'toClient') {
      const c: RTCIceCandidateInit = {
        candidate: data.candidate.candidate,
        sdpMid: data.candidate.sdpMid ?? undefined,
        sdpMLineIndex: data.candidate.sdpMLineIndex ?? undefined,
      };
      if (!this.remoteSet) this.early.push(c);
      else await this.pc.addIceCandidate(c).catch(() => {});
    } else if (data.type === 'bye' && data.dir === 'toClient') {
      this.fail('host closed the relay');
    }
  }

  get isOpen() {
    return this.opened && !this.closed && this.dc.readyState === 'open';
  }

  send(msg: ClientToRelay): boolean {
    if (!this.isOpen) return false;
    this.dc.send(JSON.stringify(msg));
    return true;
  }

  async setMicTrack(track: MediaStreamTrack | null) {
    await this.micSender?.replaceTrack(track);
  }

  private fail(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.pc.close();
    this.emit('failed', { reason });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    void this.opts.sendSignal({ type: 'bye', epoch: this.opts.epoch, dir: 'toRelay' }).catch(() => {});
    try {
      this.dc.close();
    } catch {
      /* ignore */
    }
    this.pc.close();
    this.emit('closed', undefined);
  }
}
