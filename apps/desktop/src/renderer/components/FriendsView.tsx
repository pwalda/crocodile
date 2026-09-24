import { useState } from 'react';
import { Check, MessageCircle, Phone, UserMinus, Users, X, ShieldBan } from 'lucide-react';
import type { ProfileView } from '@crocodile/client-core';
import { getClient, navigate, openModal, useCroc } from '../croc';
import { Avatar, Button, IconButton, UserName, cx } from './ui';

type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

export function FriendsView() {
  const [tab, setTab] = useState<Tab>('online');
  const friends = useCroc((s) => s.friends);
  const presence = useCroc((s) => s.presence);
  const client = getClient();

  const online = friends.friends.filter((f) => presence[f] && presence[f] !== 'offline');
  const rows: { userId: string; kind: 'friend' | 'incoming' | 'outgoing' | 'blocked' }[] =
    tab === 'online'
      ? online.map((userId) => ({ userId, kind: 'friend' as const }))
      : tab === 'all'
        ? friends.friends.map((userId) => ({ userId, kind: 'friend' as const }))
        : tab === 'pending'
          ? [...friends.incoming.map((userId) => ({ userId, kind: 'incoming' as const })), ...friends.outgoing.map((userId) => ({ userId, kind: 'outgoing' as const }))]
          : friends.blocked.map((userId) => ({ userId, kind: 'blocked' as const }));

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-main">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-rail px-4 shadow-sm">
        <div className="flex items-center gap-2 font-semibold text-white">
          <Users size={22} className="text-faint" /> Friends
        </div>
        <div className="h-6 w-px bg-line" />
        {(['online', 'all', 'pending', 'blocked'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx('rounded px-2 py-0.5 text-[15px] font-medium capitalize', tab === t ? 'bg-active text-white' : 'text-muted hover:bg-hover hover:text-text')}
          >
            {t}
            {t === 'pending' && friends.incoming.length > 0 && (
              <span className="ml-1.5 rounded-full bg-dnd px-1.5 text-[11px] font-bold text-white">{friends.incoming.length}</span>
            )}
          </button>
        ))}
        <button
          onClick={() => setTab('add')}
          className={cx('rounded px-2 py-0.5 text-[15px] font-medium', tab === 'add' ? 'text-croc-light' : 'bg-croc text-white')}
        >
          Add Friend
        </button>
      </header>
      {tab === 'add' ? (
        <AddFriend />
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
            {tab} — {rows.length}
          </div>
          {rows.length === 0 && (
            <p className="mt-16 text-center text-muted">
              {tab === 'pending' ? 'There are no pending friend requests.' : tab === 'online' ? 'None of your friends are online right now.' : 'Nobody here yet.'}
            </p>
          )}
          {rows.map(({ userId, kind }) => (
            <div key={userId} className="group flex items-center gap-3 border-t border-line px-2 py-3 hover:rounded-lg hover:border-transparent hover:bg-hover">
              <button onClick={() => openModal({ kind: 'profile', userId })}>
                <Avatar userId={userId} size={36} status="auto" />
              </button>
              <div className="min-w-0 flex-1">
                <UserName userId={userId} className="font-semibold text-white" />
                <div className="text-xs text-muted">
                  {kind === 'incoming' ? 'Incoming friend request' : kind === 'outgoing' ? 'Outgoing friend request' : kind === 'blocked' ? 'Blocked' : (presence[userId] ?? 'offline')}
                </div>
              </div>
              {kind === 'friend' && (
                <>
                  <IconButton label="Message" className="rounded-full bg-side" onClick={() => navigate({ kind: 'dm', userId })}>
                    <MessageCircle size={18} />
                  </IconButton>
                  <IconButton label="Call" className="rounded-full bg-side" onClick={() => { navigate({ kind: 'dm', userId }); void client.callDm(userId).catch((e) => client.reportError(e.message)); }}>
                    <Phone size={18} />
                  </IconButton>
                  <IconButton label="Remove friend" className="rounded-full bg-side" onClick={() => void client.removeFriend(userId)}>
                    <UserMinus size={18} />
                  </IconButton>
                </>
              )}
              {kind === 'incoming' && (
                <>
                  <IconButton label="Accept" className="rounded-full bg-side text-online" onClick={() => void client.addFriend(userId)}>
                    <Check size={18} />
                  </IconButton>
                  <IconButton label="Ignore and block" className="rounded-full bg-side" onClick={() => void client.block(userId)}>
                    <X size={18} />
                  </IconButton>
                </>
              )}
              {kind === 'outgoing' && (
                <IconButton label="Cancel request" className="rounded-full bg-side" onClick={() => void client.removeFriend(userId)}>
                  <X size={18} />
                </IconButton>
              )}
              {kind === 'blocked' && (
                <IconButton label="Unblock" className="rounded-full bg-side" onClick={() => void client.unblock(userId)}>
                  <ShieldBan size={18} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AddFriend() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProfileView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const me = useCroc((s) => s.me);
  const friends = useCroc((s) => s.friends);
  const client = getClient();
  const search = async () => {
    setBusy(true);
    try {
      setResults((await client.searchUsers(query)).filter((p) => p.userId !== me?.userId));
    } catch (e) {
      client.reportError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-8 py-6">
      <h2 className="font-semibold uppercase text-white">Add friend</h2>
      <p className="mt-1 text-sm text-muted">
        Search by name and tag, like <b className="text-text">{me ? `${me.username}#${me.tag}` : 'name#1234'}</b> (that's you).
      </p>
      <form
        className="mt-4 flex items-center rounded-lg bg-float px-3 py-2 focus-within:ring-2 focus-within:ring-croc/60"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) void search();
        }}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="You can add friends with their name#tag."
          className="selectable flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
        />
        <Button type="submit" disabled={!query.trim() || busy} className="h-8">
          Search
        </Button>
      </form>
      {results && results.length === 0 && <p className="mt-6 text-muted">Nobody found. Check the spelling and the #tag.</p>}
      <div className="mt-4">
        {results?.map((p) => {
          const already = friends.friends.includes(p.userId) || friends.outgoing.includes(p.userId);
          return (
            <div key={p.userId} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover">
              <Avatar userId={p.userId} size={36} />
              <div className="flex-1">
                <span className="font-semibold text-white">{p.username}</span>
                <span className="text-muted">#{p.tag}</span>
              </div>
              <Button disabled={already} onClick={() => void client.addFriend(p.userId)}>
                {already ? 'Request sent' : 'Send friend request'}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
