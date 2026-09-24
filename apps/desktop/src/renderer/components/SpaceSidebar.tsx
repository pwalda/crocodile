import { ChevronDown, Hash, LogOut, MicOff, Plus, Radio, Settings, UserPlus, Volume2, HeadphoneOff } from 'lucide-react';
import { useState } from 'react';
import { sessionIds } from '@crocodile/protocol';
import { getClient, navigate, openModal, useCroc, useUi } from '../croc';
import { Avatar, UserName, cx } from './ui';
import { UserPanel } from './UserPanel';

export function SpaceSidebar({ spaceId }: { spaceId: string }) {
  const space = useCroc((s) => s.spaces[spaceId]);
  const me = useCroc((s) => s.me?.userId);
  const unread = useCroc((s) => s.unread);
  const voice = useCroc((s) => s.voice);
  const sessions = useCroc((s) => s.sessions);
  const voiceSession = useCroc((s) => s.voiceSession);
  const view = useUi((s) => s.view);
  const [menu, setMenu] = useState(false);
  const client = getClient();
  if (!space) return <aside className="w-60 shrink-0 bg-side" />;
  const isOwner = space.owner === me;
  const text = space.channels.filter((c) => c.kind === 'text');
  const voiceChannels = space.channels.filter((c) => c.kind === 'voice');
  const activeChannel = view.kind === 'space' ? view.channelId : null;

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-side">
      <div className="relative">
        <button
          className="flex h-12 w-full items-center justify-between border-b border-rail px-4 font-semibold text-white shadow-sm hover:bg-hover"
          onClick={() => setMenu(!menu)}
        >
          <span className="truncate">{space.name}</span>
          <ChevronDown size={18} className={cx('transition-transform', menu && 'rotate-180')} />
        </button>
        {menu && (
          <div className="pop-in absolute left-2 right-2 top-12 z-20 rounded-md bg-float p-1.5 shadow-xl" onMouseLeave={() => setMenu(false)}>
            <MenuItem icon={<UserPlus size={16} />} label="Invite people" accent onClick={() => { setMenu(false); openModal({ kind: 'invite', spaceId }); }} />
            {isOwner && <MenuItem icon={<Plus size={16} />} label="Create channel" onClick={() => { setMenu(false); openModal({ kind: 'create-channel', spaceId }); }} />}
            {isOwner && <MenuItem icon={<Settings size={16} />} label="Space settings" onClick={() => { setMenu(false); openModal({ kind: 'space-settings', spaceId }); }} />}
            {!isOwner && (
              <MenuItem
                icon={<LogOut size={16} />}
                label="Leave space"
                danger
                onClick={() => {
                  setMenu(false);
                  openModal({
                    kind: 'confirm',
                    title: `Leave '${space.name}'`,
                    body: 'You will need a new invite to come back.',
                    action: 'Leave space',
                    danger: true,
                    onConfirm: async () => {
                      await client.leaveSpace(spaceId);
                      navigate({ kind: 'friends' });
                    },
                  });
                }}
              />
            )}
          </div>
        )}
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto px-2 py-3">
        <Section title="Text channels" onAdd={isOwner ? () => openModal({ kind: 'create-channel', spaceId }) : undefined} />
        {text.map((c) => {
          const active = activeChannel === c.id;
          const count = unread[c.id] ?? 0;
          return (
            <button
              key={c.id}
              onClick={() => navigate({ kind: 'space', spaceId, channelId: c.id })}
              className={cx(
                'group mb-0.5 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[15px]',
                active ? 'bg-active text-white' : count ? 'font-semibold text-white hover:bg-hover' : 'text-muted hover:bg-hover hover:text-text',
              )}
            >
              <Hash size={18} className="shrink-0 text-faint" />
              <span className="truncate">{c.name}</span>
              {count > 0 && !active && <span className="ml-auto rounded-full bg-dnd px-1.5 text-[11px] font-bold text-white">{count}</span>}
            </button>
          );
        })}

        <div className="mt-4" />
        <Section title="Voice channels" onAdd={isOwner ? () => openModal({ kind: 'create-channel', spaceId }) : undefined} />
        {voiceChannels.map((c) => {
          const sid = sessionIds.voice(spaceId, c.id);
          const occ = voice[sid];
          const live = sessions[sid];
          const joined = voiceSession === sid;
          const members = live?.members.length ? live.members : (occ?.members ?? []);
          const host = live?.host ?? occ?.host ?? null;
          return (
            <div key={c.id} className="mb-0.5">
              <button
                onClick={() => {
                  navigate({ kind: 'space', spaceId, channelId: c.id });
                  if (!joined) void client.joinVoice(spaceId, c.id).catch((e) => client.reportError(e.message));
                }}
                className={cx(
                  'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[15px]',
                  joined ? 'bg-active text-white' : 'text-muted hover:bg-hover hover:text-text',
                )}
              >
                <Volume2 size={18} className="shrink-0 text-faint" />
                <span className="truncate">{c.name}</span>
              </button>
              {members.length > 0 && (
                <div className="mb-1 ml-7 mt-0.5 flex flex-col gap-0.5">
                  {members.map((u) => {
                    const speaking = !!live?.speaking.includes(u);
                    return (
                      <button
                        key={u}
                        onClick={() => openModal({ kind: 'profile', userId: u })}
                        className="flex items-center gap-2 rounded px-1.5 py-1 text-sm text-muted hover:bg-hover hover:text-text"
                      >
                        <Avatar userId={u} size={22} speaking={speaking} />
                        <UserName userId={u} className={cx('truncate', speaking && 'text-white')} />
                        <span className="ml-auto flex items-center gap-1 text-faint">
                          {u === host && <span title="Hosting this channel's relay"><Radio size={13} className="text-croc-light" /></span>}
                          {live?.deafened.includes(u) ? <HeadphoneOff size={13} /> : live?.muted.includes(u) ? <MicOff size={13} /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <UserPanel />
    </aside>
  );
}

function Section({ title, onAdd }: { title: string; onAdd?: () => void }) {
  return (
    <div className="mb-1 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-faint">
      <span>{title}</span>
      {onAdd && (
        <button title="Create channel" onClick={onAdd} className="hover:text-text">
          <Plus size={16} />
        </button>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger, accent }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; accent?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex w-full items-center justify-between rounded px-2 py-2 text-sm',
        danger ? 'text-dnd hover:bg-danger hover:text-white' : accent ? 'text-croc-light hover:bg-croc hover:text-white' : 'text-muted hover:bg-croc hover:text-white',
      )}
    >
      {label}
      {icon}
    </button>
  );
}
