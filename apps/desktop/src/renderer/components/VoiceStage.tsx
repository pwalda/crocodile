import { HeadphoneOff, MicOff, PhoneCall, Radio, ShieldCheck, Volume2 } from 'lucide-react';
import { getClient, useCroc } from '../croc';
import { Avatar, Button, UserName, cx } from './ui';

/** Main area for a voice channel: participant tiles like Discord's call view. */
export function VoiceStage({ sessionId, title, onJoin }: { sessionId: string; title: string; onJoin: () => void }) {
  const session = useCroc((s) => s.sessions[sessionId]);
  const occ = useCroc((s) => s.voice[sessionId]);
  const joined = useCroc((s) => s.voiceSession === sessionId);
  const members = session?.members.length ? session.members : (occ?.members ?? []);
  const host = session?.host ?? occ?.host ?? null;
  return (
    <section className="flex min-w-0 flex-1 flex-col bg-rail">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/30 px-4">
        <Volume2 size={22} className="text-faint" />
        <h1 className="font-semibold text-white">{title}</h1>
        <span className="ml-auto flex items-center gap-1 text-xs text-muted">
          <ShieldCheck size={14} className="text-croc" /> Peer-to-peer · end-to-end encrypted
        </span>
      </header>
      <div className="flex flex-1 flex-wrap content-center items-center justify-center gap-4 overflow-y-auto p-6">
        {members.length === 0 && (
          <div className="text-center">
            <h2 className="text-2xl font-bold text-white">{title}</h2>
            <p className="mt-2 text-muted">No one is here yet.</p>
          </div>
        )}
        {members.map((u) => {
          const speaking = !!session?.speaking.includes(u);
          const muted = session?.muted.includes(u);
          const deaf = session?.deafened.includes(u);
          return (
            <div
              key={u}
              className={cx(
                'relative flex h-44 w-64 flex-col items-center justify-center rounded-xl bg-side transition-shadow',
                speaking && 'ring-2 ring-online',
              )}
            >
              <Avatar userId={u} size={80} speaking={speaking} />
              <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded bg-black/50 px-2 py-0.5 text-sm text-white">
                <UserName userId={u} />
                {deaf ? <HeadphoneOff size={14} /> : muted ? <MicOff size={14} /> : null}
              </div>
              {u === host && (
                <div className="absolute right-2 top-2 flex items-center gap-1 rounded bg-black/50 px-2 py-0.5 text-xs text-croc-light" title="This member's device relays the channel's encrypted audio">
                  <Radio size={12} /> Host
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!joined && (
        <div className="flex justify-center pb-8">
          <Button className="h-11 px-6" onClick={onJoin}>
            <PhoneCall size={18} /> Join voice
          </Button>
        </div>
      )}
      {joined && session && session.status !== 'connected' && (
        <p className="pb-6 text-center text-sm text-warn">
          {session.status === 'no-host' ? 'Waiting for a member who can host the call…' : 'Connecting to the host…'}
        </p>
      )}
      {joined && <VoiceControls />}
    </section>
  );
}

function VoiceControls() {
  const muted = useCroc((s) => s.muted);
  const deafened = useCroc((s) => s.deafened);
  const client = getClient();
  return (
    <div className="flex justify-center gap-3 pb-8">
      <Button variant={muted ? 'danger' : 'secondary'} onClick={() => client.setMuted(!muted)}>
        <MicOff size={18} /> {muted ? 'Unmute' : 'Mute'}
      </Button>
      <Button variant={deafened ? 'danger' : 'secondary'} onClick={() => client.setDeafened(!deafened)}>
        <HeadphoneOff size={18} /> {deafened ? 'Undeafen' : 'Deafen'}
      </Button>
      <Button variant="danger" onClick={() => void client.leaveVoice()}>
        Disconnect
      </Button>
    </div>
  );
}
