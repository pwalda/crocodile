import {
  Bell,
  Command,
  Home,
  LogOut,
  Plus,
  Settings,
  ShieldCheck,
  Smartphone,
  WifiOff,
} from 'lucide-react';
import { getClient, navigate, openModal, ui, useCroc, useUi } from '../croc';
import { colorFor, initials } from '../lib/format';
import { Logo } from './Logo';
import { Avatar, Menu, MenuItem, StatusDot, cx } from './ui';

/** Spaces as tabs across the top: one of the main departures from a rail of icons. */
export function TopBar() {
  const view = useUi((s) => s.view);
  const spaces = useCroc((s) => s.spaces);
  const unread = useCroc((s) => s.unread);
  const dmUnread = useCroc((s) =>
    Object.entries(s.unread).some(([ch, n]) => ch.startsWith('dm:') && n > 0),
  );
  const requests = useCroc((s) => s.friends.incoming.length);
  const list = Object.values(spaces).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <header className="flex h-[60px] shrink-0 items-center gap-3 px-4">
      <Logo size={34} className="shrink-0" />
      <nav className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-2">
        <Tab
          active={view.kind !== 'space'}
          onClick={() => navigate({ kind: 'friends' })}
          badge={dmUnread || requests > 0}
        >
          <Home size={16} /> Home
        </Tab>
        <span className="mx-1 h-5 w-px shrink-0 bg-line" />
        {list.map((space) => {
          const active = view.kind === 'space' && view.spaceId === space.id;
          const hasUnread = space.channels.some((c) => (unread[c.id] ?? 0) > 0);
          return (
            <Tab
              key={space.id}
              active={active}
              badge={hasUnread}
              onClick={() => {
                const first = space.channels.find((c) => c.kind === 'text');
                navigate({ kind: 'space', spaceId: space.id, channelId: first?.id ?? null });
              }}
            >
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-lg text-[10px] font-bold text-white"
                style={{ background: space.icon ? undefined : colorFor(space.id) }}
              >
                {space.icon ? (
                  <img src={space.icon} alt="" className="h-full w-full object-cover" />
                ) : (
                  initials(space.name)
                )}
              </span>
              <span className="max-w-[140px] truncate">{space.name}</span>
            </Tab>
          );
        })}
        <button
          title="Create or join a space"
          onClick={() => openModal({ kind: 'add-space' })}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-line px-3 text-sm font-semibold text-muted transition hover:border-accent hover:text-accent"
        >
          <Plus size={16} /> Space
        </button>
      </nav>
      <button
        onClick={() => ui.set({ palette: true })}
        className="hidden h-9 w-56 shrink-0 items-center gap-2 rounded-full border border-line bg-island px-3 text-sm text-faint transition hover:text-muted md:flex"
      >
        <Command size={14} /> Jump to…
        <kbd className="ml-auto rounded-md bg-raised px-1.5 text-[11px] text-muted">Ctrl K</kbd>
      </button>
      <ConnectionPill />
      <AccountMenu />
    </header>
  );
}

function Tab({
  active,
  badge,
  onClick,
  children,
}: {
  active: boolean;
  badge?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'relative flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-sm font-semibold transition',
        active ? 'island text-text !shadow-none' : 'text-text-2 hover:bg-island/60 hover:text-text',
      )}
    >
      {children}
      {badge && !active && (
        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent" />
      )}
    </button>
  );
}

function ConnectionPill() {
  const link = useCroc((s) => s.link);
  const server = useCroc((s) => s.server);
  const ok = link === 'connected';
  return (
    <button
      onClick={() => openModal({ kind: 'settings', tab: 'connection' })}
      title={
        ok
          ? `Connected to ${server?.info.name} (${Math.round(server?.rttMs ?? 0)} ms). Messages and voice never pass through it.`
          : 'Looking for a coordination server'
      }
      className={cx(
        'flex h-9 shrink-0 items-center gap-2 rounded-full px-3 text-xs font-semibold transition',
        ok ? 'bg-accent-soft text-accent' : 'bg-warn/15 text-warn',
      )}
    >
      {ok ? <ShieldCheck size={15} /> : <WifiOff size={15} />}
      {ok ? `${Math.round(server?.rttMs ?? 0)} ms` : link === 'offline' ? 'Offline' : 'Connecting'}
    </button>
  );
}

function AccountMenu() {
  const me = useCroc((s) => s.me);
  const status = useCroc((s) => s.settings.status);
  const requests = useCroc((s) => s.friends.incoming.length);
  const client = getClient();
  if (!me) return null;
  const statuses = [
    ['online', 'Online'],
    ['idle', 'Away'],
    ['dnd', 'Do not disturb'],
    ['invisible', 'Invisible'],
  ] as const;
  return (
    <Menu
      align="right"
      trigger={(toggle) => (
        <button onClick={toggle} className="relative shrink-0 rounded-xl" aria-label="Account">
          <Avatar userId={me.userId} size={36} status="auto" />
          {requests > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
              {requests}
            </span>
          )}
        </button>
      )}
    >
      {(close) => (
        <div className="w-64">
          <div className="flex items-center gap-3 rounded-xl p-2">
            <Avatar userId={me.userId} size={44} />
            <div className="min-w-0">
              <div className="truncate font-bold">{me.username}</div>
              <div className="text-xs text-muted">
                {me.username}#{me.tag}
              </div>
            </div>
          </div>
          <div className="my-1 h-px bg-line" />
          {statuses.map(([id, label]) => (
            <button
              key={id}
              onClick={() => {
                void client.setStatus(id);
                close();
              }}
              className={cx(
                'flex w-full items-center gap-3 rounded-xl px-3 py-1.5 text-left text-[13px] hover:bg-hover',
                status === id ? 'text-text' : 'text-text-2',
              )}
            >
              <StatusDot status={id === 'invisible' ? 'offline' : id} size={10} />
              {label}
            </button>
          ))}
          <div className="my-1 h-px bg-line" />
          {requests > 0 && (
            <MenuItem
              icon={<Bell size={16} />}
              label={`${requests} friend request${requests === 1 ? '' : 's'}`}
              onClick={() => {
                close();
                navigate({ kind: 'friends' });
              }}
            />
          )}
          <MenuItem
            icon={<Smartphone size={16} />}
            label="Link another device"
            onClick={() => {
              close();
              openModal({ kind: 'link-device' });
            }}
          />
          <MenuItem
            icon={<Settings size={16} />}
            label="Settings"
            hint="Ctrl ,"
            onClick={() => {
              close();
              openModal({ kind: 'settings' });
            }}
          />
          <MenuItem
            icon={<LogOut size={16} />}
            label="Profile & account"
            onClick={() => {
              close();
              openModal({ kind: 'settings', tab: 'account' });
            }}
          />
        </div>
      )}
    </Menu>
  );
}
