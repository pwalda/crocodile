import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AtSign,
  CircleAlert,
  Hash,
  Pencil,
  Phone,
  Reply,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type { MessageView } from '@crocodile/client-core';
import { getClient, openModal, ui, useCroc, useUi } from '../croc';
import { dayOf, renderMessage, stampOf, timeOf } from '../lib/format';
import { Avatar, IconButton, UserName, cx } from './ui';

export function ChatView({
  channel,
  title,
  topic,
  kind,
  otherUserId,
}: {
  channel: string;
  title: string;
  topic?: string;
  kind: 'channel' | 'dm';
  otherUserId?: string;
}) {
  const messages = useCroc((s) => s.messages[channel]);
  const sessionId = kind === 'dm' ? channel : getClient().sessionOfChannel(channel);
  const session = useCroc((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const typing = useCroc((s) => s.typing[channel]);
  const showMembers = useUi((s) => s.showMembers);
  const me = useCroc((s) => s.me?.userId);
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const client = getClient();

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages?.length, channel]);

  useEffect(() => {
    stick.current = true;
    setReplyTo(null);
    setEditing(null);
  }, [channel]);

  const typers = Object.entries(typing ?? {})
    .filter(([u, until]) => u !== me && until > Date.now())
    .map(([u]) => u);

  const peers = session?.peers.length ?? 0;
  const connection =
    !session || session.status === 'joining' || session.status === 'connecting'
      ? 'Connecting to peers…'
      : session.status === 'reconnecting'
        ? 'Reconnecting to peers…'
        : session.status === 'no-host'
          ? 'Nobody online can host right now; messages are kept on your device.'
          : null;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-main">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 shadow-sm">
        {kind === 'dm' ? (
          <AtSign size={22} className="text-faint" />
        ) : (
          <Hash size={22} className="text-faint" />
        )}
        <h1 className="font-semibold text-white">{title}</h1>
        {topic && (
          <span className="ml-2 truncate border-l border-line pl-3 text-sm text-muted">
            {topic}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <span
            className="mr-2 flex items-center gap-1 rounded bg-rail/60 px-2 py-1 text-xs text-muted"
            title="Messages go directly between peers and are end-to-end encrypted. No server stores them."
          >
            <ShieldCheck size={14} className="text-croc" /> P2P · E2EE · {peers} peer
            {peers === 1 ? '' : 's'} online
          </span>
          {kind === 'dm' && otherUserId && (
            <IconButton
              label="Start voice call"
              onClick={() =>
                void client.callDm(otherUserId).catch((e) => client.reportError(e.message))
              }
            >
              <Phone size={20} />
            </IconButton>
          )}
          {kind === 'channel' && (
            <IconButton
              label={showMembers ? 'Hide member list' : 'Show member list'}
              active={showMembers}
              onClick={() => ui.set({ showMembers: !showMembers })}
            >
              <Users size={20} />
            </IconButton>
          )}
        </div>
      </header>

      {connection && <div className="bg-warn/15 px-4 py-1.5 text-xs text-warn">{connection}</div>}

      <div
        ref={scroller}
        className="selectable flex-1 overflow-y-auto pb-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          if (el.scrollTop < 40) void client.loadOlder(channel);
        }}
      >
        <div className="px-4 pb-4 pt-12">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-active">
            {kind === 'dm' && otherUserId ? (
              <Avatar userId={otherUserId} size={64} />
            ) : (
              <Hash size={40} className="text-white" />
            )}
          </div>
          <h2 className="mt-3 text-3xl font-bold text-white">
            {kind === 'dm' ? title : `Welcome to #${title}!`}
          </h2>
          <p className="mt-1 text-muted">
            {kind === 'dm'
              ? `This is the beginning of your conversation with ${title}. It travels only between your devices.`
              : `This is the start of the #${title} channel.`}
          </p>
        </div>
        <MessageList
          messages={messages ?? []}
          me={me}
          onReply={setReplyTo}
          editing={editing}
          setEditing={setEditing}
          channel={channel}
        />
      </div>

      <div className="px-4 pb-6">
        {replyTo && (
          <div className="flex items-center justify-between rounded-t-md bg-side px-4 py-2 text-sm text-muted">
            <span>
              Replying to <UserName userId={replyTo.author} className="font-semibold text-text" />
            </span>
            <button onClick={() => setReplyTo(null)} className="hover:text-text">
              <X size={16} />
            </button>
          </div>
        )}
        <Composer
          channel={channel}
          placeholder={kind === 'dm' ? `Message @${title}` : `Message #${title}`}
          onSend={async (text) => {
            await client.sendMessage(channel, text, replyTo ? { replyTo: replyTo.id } : {});
            setReplyTo(null);
            stick.current = true;
          }}
          rounded={!replyTo}
        />
        <div className="h-5 pt-1 text-xs text-muted">
          {typers.length > 0 && (
            <span>
              <b className="text-text">
                {typers.map((u) => getClient().state.profiles[u]?.username ?? 'Someone').join(', ')}
              </b>{' '}
              {typers.length === 1 ? 'is' : 'are'} typing…
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function MessageList({
  messages,
  me,
  onReply,
  editing,
  setEditing,
  channel,
}: {
  messages: MessageView[];
  me?: string;
  onReply: (m: MessageView) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
  channel: string;
}) {
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  return (
    <div>
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || dayOf(prev.ts) !== dayOf(m.ts);
        const grouped =
          !!prev &&
          !newDay &&
          prev.author === m.author &&
          m.ts - prev.ts < 5 * 60_000 &&
          !m.replyTo;
        const replied = m.replyTo ? byId.get(m.replyTo) : undefined;
        return (
          <div key={m.id}>
            {newDay && (
              <div className="mx-4 my-3 flex items-center gap-2 text-xs font-semibold text-faint">
                <div className="h-px flex-1 bg-line" />
                {dayOf(m.ts)}
                <div className="h-px flex-1 bg-line" />
              </div>
            )}
            <Message
              message={m}
              grouped={grouped}
              replied={replied}
              mine={m.author === me}
              onReply={onReply}
              editing={editing === m.id}
              setEditing={setEditing}
              channel={channel}
            />
          </div>
        );
      })}
    </div>
  );
}

function Message({
  message: m,
  grouped,
  replied,
  mine,
  onReply,
  editing,
  setEditing,
  channel,
}: {
  message: MessageView;
  grouped: boolean;
  replied?: MessageView;
  mine: boolean;
  onReply: (m: MessageView) => void;
  editing: boolean;
  setEditing: (id: string | null) => void;
  channel: string;
}) {
  const client = getClient();
  const [draft, setDraft] = useState(m.body);
  if (m.deleted) return null;
  return (
    <div
      className={cx(
        'group relative flex gap-4 px-4 hover:bg-[#2e3035]',
        grouped ? 'py-0.5' : 'mt-3 py-0.5',
      )}
    >
      <div className="w-10 shrink-0">
        {grouped ? (
          <span className="invisible block pt-1 text-[11px] text-faint group-hover:visible">
            {timeOf(m.ts)}
          </span>
        ) : (
          <button
            onClick={() => openModal({ kind: 'profile', userId: m.author })}
            className="mt-0.5"
          >
            <Avatar userId={m.author} size={40} />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {replied && (
          <div className="mb-0.5 flex items-center gap-1 truncate text-xs text-muted">
            <Reply size={12} className="scale-x-[-1]" />
            <UserName userId={replied.author} className="font-semibold text-text" />
            <span className="truncate">{replied.body}</span>
          </div>
        )}
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <button
              onClick={() => openModal({ kind: 'profile', userId: m.author })}
              className="font-medium text-white hover:underline"
            >
              <UserName userId={m.author} />
            </button>
            <span className="text-xs text-faint">{stampOf(m.ts)}</span>
          </div>
        )}
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim() && draft !== m.body) void client.editMessage(channel, m.id, draft);
              setEditing(null);
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
              className="mt-1 w-full rounded bg-input px-3 py-2 text-[15px] outline-none"
            />
            <div className="mt-1 text-xs text-muted">escape to cancel · enter to save</div>
          </form>
        ) : (
          <div className="whitespace-pre-wrap break-words text-[15px] leading-[1.375rem] text-text">
            {renderMessage(m.body)}
            {m.edited && <span className="ml-1 text-[10px] text-faint">(edited)</span>}
            {m.pending && (
              <span
                className="ml-2 inline-flex items-center gap-1 text-[11px] text-warn"
                title="Nobody else was online; it will be delivered peer-to-peer when they are."
              >
                <CircleAlert size={12} /> waiting for peers
              </span>
            )}
          </div>
        )}
      </div>
      {!editing && (
        <div className="absolute -top-4 right-4 hidden rounded-md border border-line bg-main shadow group-hover:flex">
          <IconButton label="Reply" onClick={() => onReply(m)}>
            <Reply size={16} />
          </IconButton>
          {mine && (
            <IconButton
              label="Edit"
              onClick={() => {
                setDraft(m.body);
                setEditing(m.id);
              }}
            >
              <Pencil size={16} />
            </IconButton>
          )}
          {mine && (
            <IconButton
              label="Delete"
              danger
              onClick={() => void client.deleteMessage(channel, m.id)}
            >
              <Trash2 size={16} />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

function Composer({
  channel,
  placeholder,
  onSend,
  rounded,
}: {
  channel: string;
  placeholder: string;
  onSend: (text: string) => Promise<void>;
  rounded: boolean;
}) {
  const [text, setText] = useState('');
  const lastTyping = useRef(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setText('');
    ref.current?.focus();
  }, [channel]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  return (
    <div className={cx('flex bg-input px-4', rounded ? 'rounded-lg' : 'rounded-b-lg')}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        maxLength={4000}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          if (Date.now() - lastTyping.current > 3000) {
            lastTyping.current = Date.now();
            getClient().sendTyping(channel);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const value = text;
            if (!value.trim()) return;
            setText('');
            void onSend(value).catch((err) => getClient().reportError(err.message));
          }
        }}
        className="selectable max-h-60 flex-1 resize-none bg-transparent py-3 text-[15px] text-text outline-none placeholder:text-faint"
      />
    </div>
  );
}
