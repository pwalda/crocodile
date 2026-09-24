import { Plus } from 'lucide-react';
import { navigate, openModal, useCroc, useUi } from '../croc';
import { colorFor, initials } from '../lib/format';
import { Logo } from './Logo';
import { cx } from './ui';

function RailItem({
  active,
  unread,
  label,
  onClick,
  children,
  color,
}: {
  active: boolean;
  unread?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="group relative flex w-full justify-center">
      <span
        className={cx(
          'absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r bg-white transition-all',
          active ? 'h-10' : unread ? 'h-2' : 'h-0 group-hover:h-5',
        )}
      />
      <button
        title={label}
        aria-label={label}
        onClick={onClick}
        className={cx(
          'flex h-12 w-12 items-center justify-center overflow-hidden text-[15px] font-semibold text-white transition-all',
          active ? 'rounded-2xl' : 'rounded-3xl hover:rounded-2xl',
        )}
        style={{ background: color }}
      >
        {children}
      </button>
    </div>
  );
}

export function ServerRail() {
  const view = useUi((s) => s.view);
  const spaces = useCroc((s) => s.spaces);
  const unread = useCroc((s) => s.unread);
  const dmUnread = useCroc((s) => Object.entries(s.unread).some(([ch, n]) => ch.startsWith('dm:') && n > 0));
  const list = Object.values(spaces).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <nav className="thin-scroll flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-rail py-3">
      <RailItem active={view.kind !== 'space'} unread={dmUnread} label="Direct messages" onClick={() => navigate({ kind: 'friends' })} color={view.kind !== 'space' ? '#2fa56f' : '#313338'}>
        <Logo size={30} />
      </RailItem>
      <div className="mx-auto h-0.5 w-8 rounded bg-line" />
      {list.map((space) => {
        const active = view.kind === 'space' && view.spaceId === space.id;
        const hasUnread = space.channels.some((c) => (unread[c.id] ?? 0) > 0);
        return (
          <RailItem
            key={space.id}
            label={space.name}
            active={active}
            unread={hasUnread}
            color={space.icon ? undefined : active ? colorFor(space.id) : '#313338'}
            onClick={() => {
              const first = space.channels.find((c) => c.kind === 'text');
              navigate({ kind: 'space', spaceId: space.id, channelId: first?.id ?? null });
            }}
          >
            {space.icon ? <img src={space.icon} alt="" className="h-full w-full object-cover" /> : initials(space.name)}
          </RailItem>
        );
      })}
      <RailItem active={false} label="Add a space" onClick={() => openModal({ kind: 'add-space' })} color="#313338">
        <Plus className="text-croc transition-colors group-hover:text-white" size={24} />
      </RailItem>
    </nav>
  );
}
