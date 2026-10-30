import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Hash, Volume2 } from 'lucide-react';
import { INVITE_MAX_MS } from '@crocodile/crypto';
import type { ChannelKind } from '@crocodile/protocol';
import { closeModal, getClient, navigate, openModal, useCroc } from '../croc';
import { copyText, imageToDataUrl, initials } from '../lib/format';
import {
  Avatar,
  Button,
  Input,
  Label,
  Modal,
  Segmented,
  Toggle,
  UserName,
  cx,
} from '../components/ui';

export function AddSpaceModal() {
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose');
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>();
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = useCroc((s) => s.me?.username);
  const client = getClient();

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      const spaceId = await fn();
      closeModal();
      const space = client.state.spaces[spaceId];
      navigate({
        kind: 'space',
        spaceId,
        channelId: space?.channels.find((c) => c.kind === 'text')?.id ?? null,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'choose') {
    return (
      <Modal
        title="Add a space"
        subtitle="A space is where you and your friends hang out: text channels, voice channels, all peer-to-peer."
        onClose={closeModal}
      >
        <button
          onClick={() => {
            setName(`${me ?? 'My'}'s space`);
            setMode('create');
          }}
          className="mb-3 w-full rounded-2xl border border-line bg-island-2 px-4 py-4 transition hover:border-accent text-left font-semibold text-text hover:bg-hover"
        >
          Create my own
        </button>
        <div className="mt-4 text-center">
          <h3 className="font-semibold text-text">Have an invite already?</h3>
          <Button variant="secondary" className="mt-2 w-full" onClick={() => setMode('join')}>
            Join a space
          </Button>
        </div>
      </Modal>
    );
  }

  if (mode === 'create') {
    return (
      <Modal
        title="Customize your space"
        subtitle="Give it a personality with a name and an icon. You can change them later."
        onClose={closeModal}
        footer={
          <>
            <Button variant="ghost" onClick={() => setMode('choose')}>
              Back
            </Button>
            <Button
              disabled={!name.trim() || busy}
              onClick={() => void run(() => client.createSpace(name, icon))}
            >
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </>
        }
      >
        <label className="mx-auto mb-5 flex h-20 w-20 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-muted text-xl font-bold text-muted hover:border-text">
          {icon ? (
            <img src={icon} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(name || '?')
          )}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) =>
              e.target.files?.[0] && setIcon(await imageToDataUrl(e.target.files[0]))
            }
          />
        </label>
        <Label>Space name</Label>
        <Input autoFocus maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </Modal>
    );
  }

  return (
    <Modal
      title="Join a space"
      subtitle="Enter an invite code or link."
      onClose={closeModal}
      footer={
        <>
          <Button variant="ghost" onClick={() => setMode('choose')}>
            Back
          </Button>
          <Button
            disabled={!invite.trim() || busy}
            onClick={() => void run(() => client.joinWithInvite(invite))}
          >
            {busy ? 'Joining…' : 'Join space'}
          </Button>
        </>
      }
    >
      <Label>Invite code or link</Label>
      <Input
        autoFocus
        value={invite}
        onChange={(e) => setInvite(e.target.value)}
        placeholder="croc://join/abcd2345"
      />
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </Modal>
  );
}

const DAY_MS = 86_400_000;
const LINK_LIFETIMES = { '1d': DAY_MS, '7d': 7 * DAY_MS, '30d': INVITE_MAX_MS } as const;
type LinkLifetime = keyof typeof LINK_LIFETIMES;

export function InviteModal({ spaceId }: { spaceId: string }) {
  const space = useCroc((s) => s.spaces[spaceId]);
  const client = getClient();
  const [lifetime, setLifetime] = useState<LinkLifetime>('7d');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'new' | 'off' | null>(null);
  const open = client.openInviteOf(spaceId);
  const code = open?.body.code ?? null;
  // The link on offer is the one the space has on, looked for before one is made; with none, one is
  // made when the window opens.
  const [offered, setOffered] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    client
      .shareInvite(spaceId)
      .catch((e: Error) => setError(e.message))
      .finally(() => setOffered(true));
  }, [client, spaceId]);
  const run = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await what();
      setCopied(false);
      setConfirm(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const link = code ? `croc://join/${code}` : '';
  const expiresAt = open?.body.expiresAt ?? undefined;
  const days = expiresAt ? Math.max(1, Math.round((expiresAt - Date.now()) / DAY_MS)) : undefined;
  return (
    <Modal
      title={`Invite friends to ${space?.name ?? 'this space'}`}
      subtitle={
        days === undefined
          ? 'Anyone with the link can join.'
          : `Anyone with this link can join for the next ${days === 1 ? 'day' : `${days} days`}.`
      }
      onClose={closeModal}
    >
      <Label>Invite link</Label>
      <div className="flex items-center gap-2 rounded-xl bg-field p-1 pl-3">
        <span className="selectable flex-1 truncate font-mono text-sm">
          {error ?? (link || (offered ? 'No link is on.' : 'Creating invite…'))}
        </span>
        <Button
          disabled={!code}
          className={cx(copied && 'bg-online')}
          onClick={async () => {
            await copyText(link);
            setCopied(true);
          }}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {code && (
        <p className="mt-3 text-xs text-muted">
          Friends can also paste just the code: <b className="selectable text-text">{code}</b>
        </p>
      )}
      <p className="mt-3 text-xs text-muted">
        There is one link at a time. A new link replaces this one, and turning it off stops it
        working; people already in stay. To bring one person in, invite them from their profile
        instead.
      </p>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Label>New link lasts</Label>
          <Segmented
            label="New link lasts"
            value={lifetime}
            options={[
              { id: '1d', label: '1 day' },
              { id: '7d', label: '7 days' },
              { id: '30d', label: '30 days' },
            ]}
            onChange={(v) => {
              setConfirm(null);
              setLifetime(v);
            }}
          />
        </div>
        <div className="flex gap-2">
          {code && (
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm('off')}>
              Turn off…
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              code
                ? setConfirm('new')
                : void run(() => client.createInvite(spaceId, LINK_LIFETIMES[lifetime]))
            }
          >
            {code ? 'New link…' : 'Make a link'}
          </Button>
        </div>
      </div>
      {confirm && (
        <div className="mt-4 rounded-2xl border border-line bg-island-2 p-4">
          <p className="text-sm text-text">
            {confirm === 'new'
              ? 'The link above stops working and a new one takes its place. Anyone who has not joined yet will need the new one.'
              : 'The link stops working. Nobody can join with a link until you make a new one.'}
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  confirm === 'new'
                    ? client.createInvite(spaceId, LINK_LIFETIMES[lifetime])
                    : client.stopOpenInvite(spaceId),
                )
              }
            >
              {confirm === 'new' ? 'Make a new link' : 'Turn off'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Pick a space to invite one person to: an invitation only they can use, sent as a message. */
export function InvitePersonModal({ userId }: { userId: string }) {
  useCroc((s) => s.spaces);
  const profile = useCroc((s) => s.profiles[userId]);
  const [busy, setBusy] = useState<string | null>(null);
  const client = getClient();
  const choices = client.spacesToInviteTo(userId);
  const name = profile?.username ?? 'this person';
  return (
    <Modal
      title={`Invite ${name} to a space`}
      subtitle="They get an invitation only they can use, for a week."
      onClose={closeModal}
    >
      {choices.length === 0 && (
        <p className="rounded-xl bg-field px-3 py-2 text-sm text-muted">
          There is no space you can invite {name} to.
        </p>
      )}
      {choices.map((s) => (
        <button
          key={s.id}
          disabled={busy !== null}
          className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-hover disabled:opacity-50"
          onClick={async () => {
            setBusy(s.id);
            try {
              await client.inviteToSpace(s.id, userId);
              closeModal();
              navigate({ kind: 'dm', userId });
            } catch (e) {
              client.reportError((e as Error).message);
              setBusy(null);
            }
          }}
        >
          {s.icon ? (
            <img src={s.icon} alt="" className="h-9 w-9 rounded-xl object-cover" />
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-sm font-bold text-accent">
              {initials(s.name)}
            </span>
          )}
          <span className="flex-1 truncate font-semibold">{s.name}</span>
          <span className="text-xs text-muted">{busy === s.id ? 'Sending…' : 'Invite'}</span>
        </button>
      ))}
    </Modal>
  );
}

export function CreateChannelModal({ spaceId }: { spaceId: string }) {
  const [kind, setKind] = useState<ChannelKind>('text');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const client = getClient();
  const create = async () => {
    setBusy(true);
    try {
      await client.addChannel(spaceId, name, kind);
      closeModal();
    } catch (e) {
      client.reportError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create channel"
      onClose={closeModal}
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || busy} onClick={() => void create()}>
            Create channel
          </Button>
        </>
      }
    >
      <Label>Channel type</Label>
      {(['text', 'voice'] as ChannelKind[]).map((k) => (
        <button
          key={k}
          onClick={() => setKind(k)}
          className={cx(
            'mb-2 flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition',
            kind === k ? 'border-accent bg-accent-soft' : 'border-line bg-island-2 hover:bg-hover',
          )}
        >
          {k === 'text' ? <Hash size={22} /> : <Volume2 size={22} />}
          <div>
            <div className="font-medium text-text">{k === 'text' ? 'Text' : 'Voice'}</div>
            <div className="text-xs text-muted">
              {k === 'text' ? 'Messages, emoji and opinions' : 'Hang out together with voice'}
            </div>
          </div>
          <span
            className={cx(
              'ml-auto h-5 w-5 rounded-full border-2',
              kind === k ? 'border-accent bg-accent' : 'border-muted',
            )}
          />
        </button>
      ))}
      <div className="mt-3">
        <Label>Channel name</Label>
        <Input
          autoFocus
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()}
          placeholder={kind === 'text' ? 'new-channel' : 'Lounge'}
        />
      </div>
    </Modal>
  );
}

export function SpaceSettingsModal({ spaceId }: { spaceId: string }) {
  const space = useCroc((s) => s.spaces[spaceId]);
  const me = useCroc((s) => s.me?.userId);
  const [name, setName] = useState(space?.name ?? '');
  const [icon, setIcon] = useState(space?.icon);
  // Null until the switch is touched: what is saved is what was chosen here, never a stale guess.
  const [chosenInvite, setChosenInvite] = useState<boolean | null>(null);
  const membersInvite = chosenInvite ?? space?.invitePolicy === 'members';
  const client = getClient();
  if (!space) return null;
  const isOwner = space.owner === me;
  // Members, and admins who are no longer members (so their rights can still be taken back).
  const people = [...new Set([...space.members, ...space.admins])].filter((u) => u !== space.owner);
  const save = async () => {
    await client.updateSpace(spaceId, (b) => ({
      ...b,
      name: name.trim() || b.name,
      ...(icon ? { icon } : {}),
      // Only what was changed here: a change somebody else made meanwhile stays.
      ...(chosenInvite !== null ? { invitePolicy: chosenInvite ? 'members' : 'admins' } : {}),
    }));
    closeModal();
  };
  return (
    <Modal
      title="Space settings"
      onClose={closeModal}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={() => void save().catch((e) => client.reportError(e.message))}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex gap-6">
        <label className="flex h-24 w-24 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-[28px] bg-active text-2xl font-bold text-text">
          {icon ? <img src={icon} alt="" className="h-full w-full object-cover" /> : initials(name)}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) =>
              e.target.files?.[0] && setIcon(await imageToDataUrl(e.target.files[0]))
            }
          />
        </label>
        <div className="flex-1">
          <Label>Space name</Label>
          <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      {isOwner && (
        <div className="mt-6 flex items-center gap-3">
          <div className="flex-1">
            <Label>Members can invite people</Label>
            <p className="text-xs text-muted">
              Otherwise only the owner and admins can invite someone by name. The invite link for
              everyone always stays with them.
            </p>
          </div>
          <Toggle
            checked={membersInvite}
            label="Members can invite people"
            onChange={setChosenInvite}
          />
        </div>
      )}
      <div className="mt-6">
        <Label>Channels</Label>
        {space.channels.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-hover">
            {c.kind === 'text' ? (
              <Hash size={16} className="text-faint" />
            ) : (
              <Volume2 size={16} className="text-faint" />
            )}
            <span className="flex-1">{c.name}</span>
            <button
              className="text-xs text-danger hover:underline"
              onClick={() =>
                void client.removeChannel(spaceId, c.id).catch((e) => client.reportError(e.message))
              }
            >
              Delete
            </button>
          </div>
        ))}
      </div>
      <section aria-label="People" className="mt-6">
        <Label>People</Label>
        <p className="mb-2 text-xs text-muted">
          {isOwner
            ? 'Admins can rename the space, change its icon and channels, invite people and ban members. Only you choose admins or delete the space.'
            : "You're an admin: you can change this space, invite people and ban members. The owner chooses admins and can delete the space."}
        </p>
        {people.length === 0 && (
          <p className="rounded-xl bg-field px-3 py-2 text-sm text-muted">
            Invite people first; then you can make them admins.
          </p>
        )}
        {people.map((u) => {
          const name = client.state.profiles[u]?.username ?? 'Member';
          const admin = space.admins.includes(u);
          const gone = !space.members.includes(u);
          return (
            <div key={u} className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-hover">
              <Avatar userId={u} size={28} />
              <UserName userId={u} className="flex-1 truncate text-sm font-semibold" />
              {gone && <span className="text-xs text-muted">not a member</span>}
              {!admin && !gone && (
                <button
                  className="text-xs text-danger hover:underline"
                  onClick={() =>
                    openModal({
                      kind: 'confirm',
                      title: `Ban ${name}?`,
                      body: `${name} leaves ${space.name} and can't join again, even with an invite.`,
                      action: 'Ban',
                      danger: true,
                      onConfirm: () => client.banMember(spaceId, u),
                    })
                  }
                >
                  Ban
                </button>
              )}
              {isOwner && (
                <Toggle
                  checked={admin}
                  label={`${name} is an admin`}
                  onChange={(v) =>
                    void client.setAdmin(spaceId, u, v).catch((e) => client.reportError(e.message))
                  }
                />
              )}
            </div>
          );
        })}
      </section>
      {isOwner && (
        <div className="mt-6 rounded-2xl border border-danger/40 p-4">
          <div className="font-semibold text-text">Delete space</div>
          <p className="mt-1 text-sm text-muted">
            Everyone loses access. Messages stay only on members' devices.
          </p>
          <Button
            variant="danger"
            className="mt-3"
            onClick={() =>
              openModal({
                kind: 'confirm',
                title: `Delete ${space.name}?`,
                body: 'Everyone loses access, for good. This cannot be undone.',
                action: 'Delete space',
                danger: true,
                confirmText: space.name,
                onConfirm: async () => {
                  await client.deleteSpace(spaceId);
                  closeModal();
                  navigate({ kind: 'friends' });
                },
              })
            }
          >
            Delete space
          </Button>
        </div>
      )}
    </Modal>
  );
}
