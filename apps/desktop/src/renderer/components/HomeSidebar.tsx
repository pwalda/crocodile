import { Plus, Users, X } from 'lucide-react';
import { sessionIds } from '@crocodile/protocol';
import { getClient, navigate, openModal, useCroc, useUi } from '../croc';
import { Avatar, UserName, cx } from './ui';
import { UserPanel } from './UserPanel';

export function HomeSidebar() {
  const view = useUi((s) => s.view);
  const dms = useCroc((s) => s.dms);
  const me = useCroc((s) => s.me?.userId);
  const unread = useCroc((s) => s.unread);
  const incoming = useCroc((s) => s.friends.incoming.length);
  return (
    <aside className="flex w-60 shrink-0 flex-col bg-side">
      <div className="flex h-12 items-center border-b border-rail px-2.5 shadow-sm">
        <button
          onClick={() => openModal({ kind: 'new-dm' })}
          className="h-7 w-full rounded bg-rail px-2 text-left text-sm text-faint hover:text-muted"
        >
          Find or start a conversation
        </button>
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto px-2 py-2">
        <button
          onClick={() => navigate({ kind: 'friends' })}
          className={cx(
            'flex w-full items-center gap-3 rounded px-2 py-2.5 text-[15px] font-medium',
            view.kind === 'friends' ? 'bg-active text-white' : 'text-muted hover:bg-hover hover:text-text',
          )}
        >
          <Users size={22} /> Friends
          {incoming > 0 && <span className="ml-auto rounded-full bg-dnd px-1.5 text-[11px] font-bold text-white">{incoming}</span>}
        </button>
        <div className="mb-1 mt-4 flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-faint">
          Direct messages
          <button title="New message" className="hover:text-text" onClick={() => openModal({ kind: 'new-dm' })}>
            <Plus size={16} />
          </button>
        </div>
        {dms.map((userId) => {
          const active = view.kind === 'dm' && view.userId === userId;
          const count = me ? (unread[sessionIds.dm(me, userId)] ?? 0) : 0;
          return (
            <div
              key={userId}
              className={cx(
                'group mb-0.5 flex cursor-pointer items-center gap-3 rounded px-2 py-1.5',
                active ? 'bg-active text-white' : 'text-muted hover:bg-hover hover:text-text',
              )}
              onClick={() => navigate({ kind: 'dm', userId })}
            >
              <Avatar userId={userId} size={32} status="auto" />
              <UserName userId={userId} className={cx('flex-1 truncate text-[15px]', count > 0 && 'font-semibold text-white')} />
              {count > 0 && <span className="rounded-full bg-dnd px-1.5 text-[11px] font-bold text-white">{count}</span>}
              <button
                title="Close conversation"
                className="hidden text-faint hover:text-text group-hover:block"
                onClick={(e) => {
                  e.stopPropagation();
                  void getClient().closeDm(userId);
                  if (active) navigate({ kind: 'friends' });
                }}
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
      <UserPanel />
    </aside>
  );
}
