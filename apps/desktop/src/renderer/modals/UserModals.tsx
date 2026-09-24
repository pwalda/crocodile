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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onMouseDown={closeModal}>
      <div className="pop-in w-[380px] overflow-hidden rounded-lg bg-float shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="h-24" style={{ background: profile?.accent ?? colorFor(userId) }} />
        <div className="px-4 pb-4">
          <div className="-mt-12 mb-2 inline-block rounded-full border-[6px] border-float">
            <Avatar userId={userId} size={84} status="auto" />
          </div>
          <div className="rounded-lg bg-side p-3">
            <div className="text-xl font-bold text-white">{profile?.username ?? 'Unknown user'}</div>
            <div className="text-sm text-muted">#{profile?.tag}</div>
            {profile?.bio && <p className="selectable mt-3 whitespace-pre-wrap border-t border-line pt-3 text-sm">{profile.bio}</p>}
            {!isMe && profile && me && (
              <div className="mt-3 border-t border-line pt-3">
                <button className="flex items-center gap-1 text-xs font-semibold uppercase text-muted hover:text-text" onClick={() => setShowSafety(!showSafety)}>
                  <ShieldCheck size={14} className="text-croc" /> Verify safety number
                </button>
                {showSafety && (
                  <div className="mt-2">
                    <div className="selectable rounded bg-float p-2 text-center font-mono text-sm tracking-wider text-croc-light">
                      {safetyNumber(me.publicKey, profile.publicKey)}
                    </div>
                    <p className="mt-1 text-[11px] text-muted">Compare this with {profile.username} in person or on a call. If it matches, nobody is intercepting your encryption.</p>
                  </div>
                )}
              </div>
            )}
            {!isMe && (
              <div className="mt-4 flex gap-2">
                <Button className="flex-1" onClick={() => { closeModal(); navigate({ kind: 'dm', userId }); }}>
                  <MessageCircle size={16} /> Message
                </Button>
                <Button variant="secondary" title="Call" onClick={() => { closeModal(); navigate({ kind: 'dm', userId }); void client.callDm(userId).catch((e) => client.reportError(e.message)); }}>
                  <Phone size={16} />
                </Button>
                {!isFriend && (
                  <Button variant="secondary" disabled={pending} title="Add friend" onClick={() => void client.addFriend(userId)}>
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
  const list = friends.filter((f) => (profiles[f]?.username ?? '').toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal title="Select a friend" onClose={closeModal}>
      <Input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type the username of a friend" />
      <div className="mt-3">
        {list.length === 0 && <p className="py-6 text-center text-sm text-muted">No friends found. Add some from the Friends page.</p>}
        {list.map((u) => (
          <button key={u} className="flex w-full items-center gap-3 rounded px-2 py-2 hover:bg-hover" onClick={() => { closeModal(); navigate({ kind: 'dm', userId: u }); }}>
            <Avatar userId={u} size={32} status="auto" />
            <UserName userId={u} className="text-white" />
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function ConfirmModal({ title, body, action, danger, onConfirm }: { title: string; body: string; action: string; danger?: boolean; onConfirm: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={closeModal}
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={busy}
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
    </Modal>
  );
}
