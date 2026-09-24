import { Crown } from 'lucide-react';
import { openModal, useCroc } from '../croc';
import { Avatar, UserName } from './ui';

export function MemberList({ spaceId }: { spaceId: string }) {
  const space = useCroc((s) => s.spaces[spaceId]);
  const presence = useCroc((s) => s.presence);
  const me = useCroc((s) => s.me?.userId);
  if (!space) return null;
  const isOnline = (u: string) => u === me || (presence[u] && presence[u] !== 'offline');
  const online = space.members.filter(isOnline);
  const offline = space.members.filter((u) => !isOnline(u));
  const group = (title: string, users: string[], dim: boolean) =>
    users.length > 0 && (
      <div className="mb-4">
        <div className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-faint">
          {title} — {users.length}
        </div>
        {users.map((u) => (
          <button
            key={u}
            onClick={() => openModal({ kind: 'profile', userId: u })}
            className={`flex w-full items-center gap-3 rounded px-2 py-1.5 text-left hover:bg-hover ${dim ? 'opacity-40 hover:opacity-100' : ''}`}
          >
            <Avatar userId={u} size={32} status={dim ? undefined : 'auto'} />
            <UserName userId={u} className="truncate text-[15px] text-muted" />
            {u === space.owner && (
              <span title="Space owner">
                <Crown size={14} className="text-warn" />
              </span>
            )}
          </button>
        ))}
      </div>
    );
  return (
    <aside className="thin-scroll w-60 shrink-0 overflow-y-auto bg-side px-2 py-4">
      {group('Online', online, false)}
      {group('Offline', offline, true)}
    </aside>
  );
}
