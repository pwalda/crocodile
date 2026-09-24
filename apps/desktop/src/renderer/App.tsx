import { useEffect } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { sessionIds } from '@crocodile/protocol';
import { closeModal, getClient, navigate, openModal, ui, useCroc, useUi } from './croc';
import { desktop } from './platform';
import { Onboarding } from './components/Onboarding';
import { ServerRail } from './components/ServerRail';
import { HomeSidebar } from './components/HomeSidebar';
import { SpaceSidebar } from './components/SpaceSidebar';
import { ChatView } from './components/ChatView';
import { VoiceStage } from './components/VoiceStage';
import { FriendsView } from './components/FriendsView';
import { MemberList } from './components/MemberList';
import { Avatar, Button, Toasts, UserName } from './components/ui';
import { Logo } from './components/Logo';
import {
  AddSpaceModal,
  CreateChannelModal,
  InviteModal,
  SpaceSettingsModal,
} from './modals/SpaceModals';
import { ConfirmModal, NewDmModal, ProfileModal } from './modals/UserModals';
import { SettingsModal } from './modals/Settings';

export function App() {
  const phase = useCroc((s) => s.phase);
  if (phase === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-rail">
        <Logo size={64} className="animate-pulse" />
        <span className="text-sm text-muted">Starting Crocodile…</span>
      </div>
    );
  }
  if (phase === 'onboarding') return <Onboarding />;
  return <Shell />;
}

function Shell() {
  useGlobalBehaviours();
  const view = useUi((s) => s.view);
  const showMembers = useUi((s) => s.showMembers);
  const spaces = useCroc((s) => s.spaces);
  const me = useCroc((s) => s.me?.userId);
  const profiles = useCroc((s) => s.profiles);

  // If the space we were looking at disappears (left, banned, deleted) go home.
  useEffect(() => {
    if (view.kind === 'space' && !spaces[view.spaceId] && Object.keys(spaces).length >= 0) {
      const t = setTimeout(() => {
        if (!getClient().state.spaces[view.spaceId]) navigate({ kind: 'friends' });
      }, 3000);
      return () => clearTimeout(t);
    }
  }, [view, spaces]);

  let sidebar: React.ReactNode;
  let main: React.ReactNode;
  let members: React.ReactNode = null;

  if (view.kind === 'space') {
    const space = spaces[view.spaceId];
    const channel = space?.channels.find((c) => c.id === view.channelId);
    sidebar = <SpaceSidebar spaceId={view.spaceId} />;
    if (!space) main = <div className="flex-1 bg-main" />;
    else if (!channel) main = <EmptyState title={space.name} text="Pick a channel on the left." />;
    else if (channel.kind === 'voice') {
      const client = getClient();
      main = (
        <VoiceStage
          sessionId={sessionIds.voice(space.id, channel.id)}
          title={channel.name}
          onJoin={() =>
            void client.joinVoice(space.id, channel.id).catch((e) => client.reportError(e.message))
          }
        />
      );
    } else {
      main = (
        <ChatView channel={channel.id} title={channel.name} topic={channel.topic} kind="channel" />
      );
      if (showMembers) members = <MemberList spaceId={space.id} />;
    }
  } else if (view.kind === 'dm' && me) {
    sidebar = <HomeSidebar />;
    main = (
      <ChatView
        channel={sessionIds.dm(me, view.userId)}
        title={profiles[view.userId]?.username ?? 'Direct message'}
        kind="dm"
        otherUserId={view.userId}
      />
    );
  } else {
    sidebar = <HomeSidebar />;
    main = <FriendsView />;
  }

  return (
    <div className="flex h-full">
      <ServerRail />
      {sidebar}
      {main}
      {members}
      <Modals />
      <CallBanner />
      <Toasts />
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-main text-center">
      <Logo size={56} />
      <h2 className="mt-4 text-xl font-bold text-white">{title}</h2>
      <p className="mt-1 text-muted">{text}</p>
    </div>
  );
}

function Modals() {
  const modal = useUi((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'add-space':
      return <AddSpaceModal />;
    case 'invite':
      return <InviteModal spaceId={modal.spaceId} />;
    case 'create-channel':
      return <CreateChannelModal spaceId={modal.spaceId} />;
    case 'space-settings':
      return <SpaceSettingsModal spaceId={modal.spaceId} />;
    case 'settings':
      return <SettingsModal tab={modal.tab} />;
    case 'profile':
      return <ProfileModal userId={modal.userId} />;
    case 'new-dm':
      return <NewDmModal />;
    case 'confirm':
      return <ConfirmModal {...modal} />;
  }
}

function CallBanner() {
  const incoming = useCroc((s) => s.incomingCall);
  const outgoing = useCroc((s) => s.outgoingCall);
  const client = getClient();
  if (incoming) {
    return (
      <div className="pop-in fixed right-6 top-6 z-[55] w-72 rounded-xl bg-float p-5 text-center shadow-2xl">
        <Avatar userId={incoming.from} size={72} className="mx-auto" />
        <div className="mt-3 text-lg font-bold text-white">
          <UserName userId={incoming.from} />
        </div>
        <div className="text-sm text-muted">Incoming call…</div>
        <div className="mt-4 flex justify-center gap-4">
          <Button
            variant="danger"
            className="h-12 w-12 rounded-full p-0"
            title="Decline"
            onClick={() => client.declineCall()}
          >
            <PhoneOff size={20} />
          </Button>
          <Button
            className="h-12 w-12 rounded-full bg-online p-0"
            title="Accept"
            onClick={() => {
              navigate({ kind: 'dm', userId: incoming.from });
              void client.callDm(incoming.from).catch((e) => client.reportError(e.message));
            }}
          >
            <Phone size={20} />
          </Button>
        </div>
      </div>
    );
  }
  if (outgoing) {
    return (
      <div className="pop-in fixed right-6 top-6 z-[55] flex items-center gap-3 rounded-xl bg-float px-4 py-3 shadow-2xl">
        <Avatar userId={outgoing.to} size={36} />
        <div className="text-sm">
          <div className="font-semibold text-white">
            Calling <UserName userId={outgoing.to} />…
          </div>
        </div>
        <Button
          variant="danger"
          className="h-9 w-9 rounded-full p-0"
          title="Hang up"
          onClick={() => void client.leaveVoice()}
        >
          <PhoneOff size={16} />
        </Button>
      </div>
    );
  }
  return null;
}

/** Push-to-talk, notifications, unread badge and invite deep links. */
function useGlobalBehaviours() {
  const client = getClient();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (
        e.code === ui.get().pttKey &&
        !e.repeat &&
        !(e.target as HTMLElement)?.closest('input,textarea')
      )
        client.voiceEngine?.setPushToTalk(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === ui.get().pttKey) client.voiceEngine?.setPushToTalk(false);
    };
    const blur = () => client.voiceEngine?.setPushToTalk(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [client]);

  useEffect(
    () =>
      client.on('message', ({ channel, message, mine }) => {
        const s = client.state;
        if (mine || !s.settings.notifications || s.settings.status === 'dnd') return;
        if (document.hasFocus() && s.activeChannel === channel) return;
        const author = s.profiles[message.author]?.username ?? 'Someone';
        const space = Object.values(s.spaces).find((sp) =>
          sp.channels.some((c) => c.id === channel),
        );
        const chName = space?.channels.find((c) => c.id === channel)?.name;
        const n = new Notification(space ? `${author} (#${chName}, ${space.name})` : author, {
          body: message.body.slice(0, 200),
          silent: false,
        });
        n.onclick = () => {
          window.focus();
          if (space) navigate({ kind: 'space', spaceId: space.id, channelId: channel });
          else navigate({ kind: 'dm', userId: message.author });
        };
      }),
    [client],
  );

  const totalUnread = useCroc(
    (s) => Object.values(s.unread).reduce((a, b) => a + b, 0) + s.friends.incoming.length,
  );
  useEffect(() => {
    void desktop?.app.setBadge(totalUnread);
  }, [totalUnread]);

  useEffect(() => {
    if (!desktop) return;
    const handle = (url: string | null) => {
      if (!url) return;
      const m = url.match(/^croc:\/\/join\/([a-z2-7]+)/i);
      if (!m) return;
      closeModal();
      openModal({
        kind: 'confirm',
        title: 'Join space?',
        body: `You were invited with code ${m[1]!.toLowerCase()}.`,
        action: 'Join',
        onConfirm: async () => {
          const spaceId = await client.joinWithInvite(m[1]!);
          const space = client.state.spaces[spaceId];
          navigate({
            kind: 'space',
            spaceId,
            channelId: space?.channels.find((c) => c.kind === 'text')?.id ?? null,
          });
        },
      });
    };
    void desktop.app.takeDeepLink().then(handle);
    return desktop.app.onDeepLink(handle);
  }, [client]);
}
