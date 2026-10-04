import { useState } from 'react';
import { MessageCircle, Phone, ShieldCheck, UserPlus } from 'lucide-react';
import { safetyNumber } from '@crocodile/crypto';
import { closeModal, getClient, navigate, useCroc } from '../croc';
import { colorFor } from '../lib/format';
import { Avatar, Button, Input, Modal, UserName } from '../components/ui';

export function ProfileModal({ userId }: { userId: string }) {
  const profile = useCroc((s) => s.profiles[userId]);
  const me = useCroc((s) => s.me);
  const friends = useCroc((s) => s.friends);
  const [showSafety, setShowSafety] = useState(false);
  const client = getClient();
  const isMe = me?.userId === userId;
  const isFriend = friends.friends.includes(userId);
  const pending = friends.outgoing.includes(userId);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm"
      onMouseDown={closeModal}
    >
      <div
        className="island rise w-[380px] overflow-hidden rounded-3xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="h-24" style={{ background: profile?.accent ?? colorFor(userId) }} />
        <div className="px-4 pb-4">
          <div className="-mt-12 mb-2 inline-block rounded-[32px] border-[6px] border-[var(--island)]">
            <Avatar userId={userId} size={84} status="auto" />
          </div>
          <div className="rounded-2xl bg-island-2 p-4">
            <div className="text-xl font-bold text-text">{profile?.username ?? 'Unknown user'}</div>
            <div className="text-sm text-muted">#{profile?.tag}</div>
            {profile?.bio && (
              <p className="selectable mt-3 whitespace-pre-wrap border-t border-line pt-3 text-sm">
                {profile.bio}
              </p>
            )}
            {!isMe && profile && me && (
              <div className="mt-3 border-t border-line pt-3">
                <button
                  className="flex items-center gap-1 text-xs font-semibold uppercase text-muted hover:text-text"
                  onClick={() => setShowSafety(!showSafety)}
                >
                  <ShieldCheck size={14} className="text-accent" /> Verify safety number
                </button>
                {showSafety && (
                  <div className="mt-2">
                    <div className="selectable rounded-xl bg-field p-2 text-center font-mono text-sm tracking-wider text-accent">
                      {safetyNumber(me.publicKey, profile.publicKey)}
                    </div>
                    <p className="mt-1 text-[11px] text-muted">
                      Compare this with {profile.username} in person or on a call. If it matches,
                      nobody is intercepting your encryption.
                    </p>
                  </div>
                )}
              </div>
            )}
            {!isMe && (
              <div className="mt-4 flex gap-2">
                <Button
                  className="flex-1"
                  onClick={() => {
                    closeModal();
                    navigate({ kind: 'dm', userId });
                  }}
                >
                  <MessageCircle size={16} /> Message
                </Button>
                <Button
                  variant="secondary"
                  title="Call"
                  onClick={() => {
                    closeModal();
                    navigate({ kind: 'dm', userId });
                    void client.callDm(userId).catch((e) => client.reportError(e.message));
                  }}
                >
                  <Phone size={16} />
                </Button>
                {!isFriend && (
                  <Button
                    variant="secondary"
                    disabled={pending}
                    title="Add friend"
                    onClick={() => void client.addFriend(userId)}
                  >
                    <UserPlus size={16} />
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function NewDmModal() {
  const friends = useCroc((s) => s.friends.friends);
  const profiles = useCroc((s) => s.profiles);
  const [filter, setFilter] = useState('');
  const list = friends.filter((f) =>
    (profiles[f]?.username ?? '').toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Modal title="Select a friend" onClose={closeModal}>
      <Input
        autoFocus
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Type the username of a friend"
      />
      <div className="mt-3">
        {list.length === 0 && (
          <p className="py-6 text-center text-sm text-muted">
            No friends found. Add some from the Friends page.
          </p>
        )}
        {list.map((u) => (
          <button
            key={u}
            className="flex w-full items-center gap-3 rounded-xl px-2 py-2 hover:bg-hover"
            onClick={() => {
              closeModal();
              navigate({ kind: 'dm', userId: u });
            }}
          >
            <Avatar userId={u} size={32} status="auto" />
            <UserName userId={u} className="text-text" />
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function ConfirmModal({
  title,
  body,
  action,
  danger,
  confirmText,
  onConfirm,
}: {
  title: string;
  body: string;
  action: string;
  danger?: boolean;
  confirmText?: string;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const confirmed = !confirmText || typed.trim() === confirmText;
  return (
    <Modal
      title={title}
      onClose={closeModal}
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={busy || !confirmed}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                closeModal();
              } catch (e) {
                getClient().reportError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            {action}
          </Button>
        </>
      }
    >
      <p className="text-center text-muted">{body}</p>
      {confirmText && (
        <label className="mt-4 block text-sm text-muted">
          Type <b className="selectable text-text">{confirmText}</b> to confirm
          <Input
            className="mt-2"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label={`Type ${confirmText} to confirm`}
          />
        </label>
      )}
    </Modal>
  );
}
