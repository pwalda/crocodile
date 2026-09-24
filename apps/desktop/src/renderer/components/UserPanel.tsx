import {
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
  Settings,
  ShieldCheck,
  Signal,
} from 'lucide-react';
import { getClient, navigate, openModal, useCroc } from '../croc';
import { Avatar, IconButton, cx } from './ui';
import { parseSessionId } from '@crocodile/protocol';

export function VoicePanel() {
  const voiceSession = useCroc((s) => s.voiceSession);
  const session = useCroc((s) => (s.voiceSession ? s.sessions[s.voiceSession] : undefined));
  const spaces = useCroc((s) => s.spaces);
  const hostName = useCroc((s) => (session?.host ? s.profiles[session.host]?.username : undefined));
  const me = useCroc((s) => s.me?.userId);
  if (!voiceSession) return null;
  const scope = parseSessionId(voiceSession);
  let where = 'Direct call';
  let onClick = () => {};
  if (scope?.kind === 'voice') {
    const space = spaces[scope.spaceId];
    const ch = space?.channels.find((c) => c.id === scope.channelId);
    where = `${ch?.name ?? 'Voice'} / ${space?.name ?? ''}`;
    onClick = () => navigate({ kind: 'space', spaceId: scope.spaceId, channelId: scope.channelId });
  } else if (scope?.kind === 'dm' && me) {
    const other = scope.users.find((u) => u !== me)!;
    onClick = () => navigate({ kind: 'dm', userId: other });
  }
  const status = session?.status ?? 'joining';
  const connected = status === 'connected';
  const label =
    status === 'connected'
      ? 'Voice Connected'
      : status === 'no-host'
        ? 'Waiting for a host'
        : status === 'reconnecting'
          ? 'Reconnecting…'
          : 'Connecting…';

  return (
    <div className="border-b border-line bg-panel px-2 py-2">
      <div className="flex items-center">
        <div className="min-w-0 flex-1 px-1">
          <div
            className={cx(
              'flex items-center gap-1.5 text-sm font-semibold',
              connected ? 'text-online' : 'text-warn',
            )}
          >
            <Signal size={16} /> {label}
          </div>
          <button
            onClick={onClick}
            className="block max-w-full truncate text-xs text-muted hover:text-text hover:underline"
          >
            {where}
          </button>
        </div>
        <IconButton label="Disconnect" onClick={() => void getClient().leaveVoice()}>
          <PhoneOff size={18} />
        </IconButton>
      </div>
      {session && (
        <div
          className="mt-1 flex items-center gap-2 px-1 text-[11px] text-faint"
          title="Voice goes peer-to-peer through the host's device and is end-to-end encrypted."
        >
          <ShieldCheck size={12} className="text-croc" /> E2EE
          <Radio size={12} />{' '}
          {session.iAmHost
            ? 'You are hosting'
            : hostName
              ? `Hosted by ${hostName}`
              : 'Electing host…'}
        </div>
      )}
    </div>
  );
}

export function UserPanel() {
  const me = useCroc((s) => s.me);
  const muted = useCroc((s) => s.muted);
  const deafened = useCroc((s) => s.deafened);
  const link = useCroc((s) => s.link);
  const client = getClient();
  if (!me) return null;
  const linkText =
    link === 'connected' ? null : link === 'offline' ? 'Offline — retrying' : 'Connecting…';
  return (
    <div className="bg-panel">
      <VoicePanel />
      <div className="flex h-[52px] items-center gap-2 px-2">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-hover"
          onClick={() => openModal({ kind: 'profile', userId: me.userId })}
        >
          <Avatar userId={me.userId} size={32} status="auto" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">{me.username}</div>
            <div className={cx('truncate text-xs', linkText ? 'text-warn' : 'text-muted')}>
              {linkText ?? `#${me.tag}`}
            </div>
          </div>
        </button>
        <IconButton
          label={muted ? 'Unmute' : 'Mute'}
          danger={muted}
          onClick={() => client.setMuted(!muted)}
        >
          {muted ? <MicOff size={18} /> : <Mic size={18} />}
        </IconButton>
        <IconButton
          label={deafened ? 'Undeafen' : 'Deafen'}
          danger={deafened}
          onClick={() => client.setDeafened(!deafened)}
        >
          {deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
        </IconButton>
        <IconButton label="User settings" onClick={() => openModal({ kind: 'settings' })}>
          <Settings size={18} />
        </IconButton>
      </div>
    </div>
  );
}
