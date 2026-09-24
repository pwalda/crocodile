import { useEffect, useState } from 'react';
import { Check, Copy, Eye, LogOut, Server, X } from 'lucide-react';
import { closeModal, getClient, saveVoiceSettings, ui, useCroc, useUi } from '../croc';
import { copyText, imageToDataUrl } from '../lib/format';
import { desktop, kv } from '../platform';
import { Avatar, Button, Input, Label, cx } from '../components/ui';
import type { CoordinatorSettings, CoordinatorStatus } from '../../main/ipc-types';

const TABS = [
  ['account', 'My Account'],
  ['voice', 'Voice & Audio'],
  ['privacy', 'Privacy & Safety'],
  ['connection', 'Connection'],
  ['host', 'Host a Server'],
  ['about', 'About'],
] as const;
type Tab = (typeof TABS)[number][0];

export function SettingsModal({ tab: initial }: { tab?: string }) {
  const [tab, setTab] = useState<Tab>((initial as Tab) ?? 'account');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeModal();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="pop-in fixed inset-0 z-50 flex bg-main">
      <div className="flex w-[280px] justify-end bg-side py-14 pr-2">
        <nav className="w-48">
          <div className="mb-1 px-2 text-xs font-bold uppercase text-faint">User settings</div>
          {TABS.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cx(
                'mb-0.5 block w-full rounded px-2.5 py-1.5 text-left text-[15px]',
                tab === id ? 'bg-active text-white' : 'text-muted hover:bg-hover hover:text-text',
              )}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="relative flex-1 overflow-y-auto">
        <div className="max-w-[740px] px-10 py-14">
          {tab === 'account' && <AccountTab />}
          {tab === 'voice' && <VoiceTab />}
          {tab === 'privacy' && <PrivacyTab />}
          {tab === 'connection' && <ConnectionTab />}
          {tab === 'host' && <HostTab />}
          {tab === 'about' && <AboutTab />}
        </div>
        <button
          onClick={closeModal}
          className="fixed right-10 top-14 flex flex-col items-center text-muted hover:text-text"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-current">
            <X size={20} />
          </span>
          <span className="mt-1 text-xs font-semibold">ESC</span>
        </button>
      </div>
    </div>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-5 text-xl font-bold text-white">{children}</h2>;
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="mb-5 flex cursor-pointer items-start justify-between gap-6 border-b border-line pb-5">
      <div>
        <div className="font-medium text-text">{label}</div>
        {hint && <div className="mt-1 text-sm text-muted">{hint}</div>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={(e) => {
          e.preventDefault();
          onChange(!checked);
        }}
        className={cx(
          'relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors',
          checked ? 'bg-croc' : 'bg-[#80848e]',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
    </label>
  );
}

function AccountTab() {
  const me = useCroc((s) => s.me);
  const [name, setName] = useState(me?.username ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [accent, setAccent] = useState(me?.accent ?? '#2fa56f');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const client = getClient();
  if (!me) return null;
  const dirty =
    name !== me.username || bio !== (me.bio ?? '') || accent !== (me.accent ?? '#2fa56f');
  return (
    <>
      <H>My Account</H>
      <div className="overflow-hidden rounded-lg bg-float">
        <div className="h-20" style={{ background: accent }} />
        <div className="flex items-end gap-4 px-4 pb-4">
          <label
            className="-mt-10 cursor-pointer rounded-full border-[6px] border-float"
            title="Change avatar"
          >
            <Avatar userId={me.userId} size={80} />
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f)
                  await client
                    .saveProfile({ avatar: await imageToDataUrl(f) })
                    .catch((err) => client.reportError(err.message));
              }}
            />
          </label>
          <div className="pb-1">
            <div className="text-xl font-bold text-white">{me.username}</div>
            <div className="text-sm text-muted">#{me.tag}</div>
          </div>
        </div>
        <div className="space-y-4 bg-side p-4">
          <div>
            <Label>Display name</Label>
            <Input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>About me</Label>
            <textarea
              value={bio}
              maxLength={190}
              onChange={(e) => setBio(e.target.value)}
              className="selectable h-20 w-full resize-none rounded bg-float p-3 text-[15px] outline-none focus:ring-2 focus:ring-croc/60"
            />
          </div>
          <div className="flex items-center gap-3">
            <Label>Banner colour</Label>
            <input
              type="color"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
              className="h-8 w-12 cursor-pointer rounded border-0 bg-transparent"
            />
          </div>
          <Button
            disabled={!dirty || !name.trim()}
            onClick={() =>
              void client
                .saveProfile({ username: name.trim(), bio, accent })
                .catch((e) => client.reportError(e.message))
            }
          >
            Save profile
          </Button>
        </div>
      </div>

      <div className="mt-10">
        <H>Recovery key</H>
        <p className="mb-3 text-sm text-muted">
          Your recovery key is your account. Use it to sign in on another device. Anyone who has it
          can impersonate you.
        </p>
        <div className="flex items-center gap-2 rounded bg-float p-3">
          <span className="selectable flex-1 break-all font-mono text-sm text-croc-light">
            {showKey ? client.recoveryKey() : '•••• •••• •••• •••• •••• •••• ••••'}
          </span>
          <Button variant="secondary" onClick={() => setShowKey(!showKey)}>
            <Eye size={16} /> {showKey ? 'Hide' : 'Reveal'}
          </Button>
          <Button
            variant="secondary"
            onClick={async () => {
              await copyText(client.recoveryKey());
              setCopied(true);
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </Button>
        </div>
        <div className="mt-2 text-xs text-faint">
          User ID: <span className="selectable font-mono">{me.userId}</span>
        </div>
      </div>

      <div className="mt-10">
        <H>Sign out</H>
        <p className="mb-3 text-sm text-muted">
          Removes your identity and local message history from this device. Make sure you saved your
          recovery key.
        </p>
        <Button
          variant="danger"
          onClick={() =>
            ui.set({
              modal: {
                kind: 'confirm',
                title: 'Sign out of this device?',
                body: 'Without your recovery key you will not be able to get this account back.',
                action: 'Sign out',
                danger: true,
                onConfirm: () => client.signOut(),
              },
            })
          }
        >
          <LogOut size={16} /> Sign out
        </Button>
      </div>
    </>
  );
}

function VoiceTab() {
  const settings = useUi((s) => s.voiceSettings);
  const level = useUi((s) => s.micLevel);
  const pttKey = useUi((s) => s.pttKey);
  const [devices, setDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>(
    { inputs: [], outputs: [] },
  );
  const [capturing, setCapturing] = useState(false);
  const [testing, setTesting] = useState(false);
  const engine = getClient().voiceEngine!;

  useEffect(() => {
    void engine.devices().then(setDevices);
  }, [engine]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      ui.set({ pttKey: e.code });
      void kv.set('ptt-key', e.code);
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, { once: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [capturing]);

  useEffect(() => {
    // Metering needs the microphone; open it while this tab is visible.
    if (!testing) return;
    const inVoice = !!getClient().state.voiceSession;
    void engine.start().catch(() => setTesting(false));
    return () => {
      if (!inVoice && !getClient().state.voiceSession) engine.stop();
    };
  }, [testing, engine]);

  const pct = Math.max(0, Math.min(100, ((level + 100) / 100) * 100));
  const threshold = ((settings.vadThresholdDb + 100) / 100) * 100;

  return (
    <>
      <H>Voice Settings</H>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Input device</Label>
          <select
            value={settings.inputDeviceId ?? ''}
            onChange={(e) => void saveVoiceSettings({ inputDeviceId: e.target.value || undefined })}
            className="h-10 w-full rounded bg-float px-2 text-sm outline-none"
          >
            <option value="">Default</option>
            {devices.inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Microphone'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Output device</Label>
          <select
            value={settings.outputDeviceId ?? ''}
            onChange={(e) =>
              void saveVoiceSettings({ outputDeviceId: e.target.value || undefined })
            }
            className="h-10 w-full rounded bg-float px-2 text-sm outline-none"
          >
            <option value="">Default</option>
            {devices.outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Speakers'}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-6">
        <Label>Output volume</Label>
        <input
          type="range"
          min={0}
          max={200}
          value={Math.round(settings.outputVolume * 100)}
          onChange={(e) => void saveVoiceSettings({ outputVolume: Number(e.target.value) / 100 })}
          className="w-full accent-croc"
        />
      </div>

      <div className="mt-6 border-t border-line pt-6">
        <Label>Input mode</Label>
        {(['vad', 'ptt'] as const).map((m) => (
          <label
            key={m}
            className="mb-2 flex cursor-pointer items-center gap-3 rounded bg-side px-3 py-2.5"
          >
            <input
              type="radio"
              checked={settings.mode === m}
              onChange={() => void saveVoiceSettings({ mode: m })}
              className="accent-croc"
            />
            {m === 'vad' ? 'Voice activity' : 'Push to talk'}
          </label>
        ))}
        {settings.mode === 'ptt' && (
          <div className="mt-3 flex items-center gap-3">
            <span className="text-sm text-muted">Shortcut</span>
            <Button variant="secondary" onClick={() => setCapturing(true)}>
              {capturing ? 'Press any key…' : pttKey}
            </Button>
            <span className="text-xs text-faint">Works while Crocodile is focused.</span>
          </div>
        )}
      </div>

      {settings.mode === 'vad' && (
        <div className="mt-6">
          <div className="flex items-center justify-between">
            <Label>Input sensitivity</Label>
            <Button
              variant="secondary"
              className="h-7 text-xs"
              onClick={() => setTesting(!testing)}
            >
              {testing ? 'Stop mic test' : "Let's check"}
            </Button>
          </div>
          <div className="relative h-3 overflow-hidden rounded bg-float">
            <div
              className={cx(
                'absolute inset-y-0 left-0 transition-[width]',
                pct > threshold ? 'bg-online' : 'bg-faint',
              )}
              style={{ width: `${pct}%` }}
            />
            <div
              className="absolute inset-y-0 w-1 -translate-x-1/2 bg-warn"
              style={{ left: `${threshold}%` }}
            />
          </div>
          <input
            type="range"
            min={-100}
            max={0}
            value={settings.vadThresholdDb}
            onChange={(e) => void saveVoiceSettings({ vadThresholdDb: Number(e.target.value) })}
            className="mt-2 w-full accent-croc"
          />
          <p className="text-xs text-faint">Sound louder than the yellow marker is transmitted.</p>
        </div>
      )}

      <div className="mt-8 border-t border-line pt-6">
        <H>Voice processing</H>
        <Toggle
          label="Echo cancellation"
          checked={settings.echoCancellation}
          onChange={(v) => void saveVoiceSettings({ echoCancellation: v })}
        />
        <Toggle
          label="Noise suppression"
          checked={settings.noiseSuppression}
          onChange={(v) => void saveVoiceSettings({ noiseSuppression: v })}
        />
        <Toggle
          label="Automatic gain control"
          checked={settings.autoGainControl}
          onChange={(v) => void saveVoiceSettings({ autoGainControl: v })}
        />
      </div>
    </>
  );
}

function PrivacyTab() {
  const settings = useCroc((s) => s.settings);
  const blocked = useCroc((s) => s.friends.blocked);
  const client = getClient();
  return (
    <>
      <H>Privacy & Safety</H>
      <Label>Status</Label>
      <div className="mb-8 grid grid-cols-4 gap-2">
        {(['online', 'idle', 'dnd', 'invisible'] as const).map((st) => (
          <button
            key={st}
            onClick={() => void client.setStatus(st)}
            className={cx(
              'rounded px-3 py-2 text-sm capitalize',
              settings.status === st ? 'bg-croc text-white' : 'bg-side text-muted hover:bg-hover',
            )}
          >
            {st === 'dnd' ? 'Do not disturb' : st}
          </button>
        ))}
      </div>
      <Toggle
        label="Let my device host calls and chats"
        hint="When your connection is the best in a group, your device relays the group's encrypted voice and text. It can never read them. Turn off on metered or slow connections."
        checked={settings.allowHosting}
        onChange={(v) => void client.updateSettings({ allowHosting: v })}
      />
      <div className="mb-8">
        <Label>Upload bandwidth (optional hint for host election)</Label>
        <select
          value={settings.uplinkKbps ?? ''}
          onChange={(e) =>
            void client.updateSettings({
              uplinkKbps: e.target.value ? Number(e.target.value) : undefined,
            })
          }
          className="h-10 w-72 rounded bg-float px-2 text-sm outline-none"
        >
          <option value="">Unknown</option>
          <option value="1000">Under 2 Mbit/s</option>
          <option value="5000">2–10 Mbit/s</option>
          <option value="20000">10–50 Mbit/s</option>
          <option value="100000">Over 50 Mbit/s</option>
        </select>
      </div>
      <Toggle
        label="Desktop notifications"
        checked={settings.notifications}
        onChange={(v) => void client.updateSettings({ notifications: v })}
      />
      <Label>Blocked users</Label>
      {blocked.length === 0 && <p className="text-sm text-muted">You haven't blocked anyone.</p>}
      {blocked.map((u) => (
        <div key={u} className="flex items-center gap-3 py-1.5">
          <Avatar userId={u} size={28} />
          <span className="flex-1">{client.state.profiles[u]?.username ?? u}</span>
          <Button
            variant="secondary"
            className="h-7 text-xs"
            onClick={() => void client.unblock(u)}
          >
            Unblock
          </Button>
        </div>
      ))}
    </>
  );
}

function ConnectionTab() {
  const server = useCroc((s) => s.server);
  const servers = useCroc((s) => s.servers);
  const link = useCroc((s) => s.link);
  const preferred = useCroc((s) => s.settings.preferredServers);
  const [url, setUrl] = useState('');
  const client = getClient();
  return (
    <>
      <H>Connection</H>
      <p className="mb-5 text-sm text-muted">
        Coordination servers introduce peers and pick hosts. They are run by volunteers, share
        metadata among themselves, and never see your messages or voice. Crocodile connects to the
        fastest one and keeps the runner-up on standby.
      </p>
      <div className="rounded-lg bg-side p-4">
        <div className="flex items-center gap-3">
          <Server size={20} className={link === 'connected' ? 'text-online' : 'text-warn'} />
          <div>
            <div className="font-semibold text-white">
              {server?.info.name ?? (link === 'offline' ? 'Not connected' : 'Connecting…')}
            </div>
            <div className="text-xs text-muted">
              {server ? `${server.info.url} · ${Math.round(server.rttMs)} ms` : link}
            </div>
          </div>
          <Button
            variant="secondary"
            className="ml-auto h-8"
            onClick={() => client.link?.reconnect()}
          >
            Reconnect
          </Button>
        </div>
      </div>
      {servers.length > 0 && (
        <div className="mt-6">
          <Label>Available servers (fastest first)</Label>
          {servers.map((s, i) => (
            <div
              key={s.info.id}
              className="flex items-center gap-3 border-b border-line py-2 text-sm"
            >
              <span className="w-24 text-xs font-semibold uppercase text-faint">
                {i === 0 ? 'Best' : i === 1 ? 'Standby' : ''}
              </span>
              <span className="flex-1 text-text">{s.info.name}</span>
              <span className="text-muted">{Math.round(s.rttMs)} ms</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-8">
        <Label>Preferred servers</Label>
        <p className="mb-2 text-sm text-muted">
          Tried before the directory's picks. Useful for private or LAN servers.
        </p>
        {preferred.map((p) => (
          <div key={p} className="flex items-center gap-2 py-1 text-sm">
            <span className="flex-1 font-mono">{p}</span>
            <button
              className="text-xs text-dnd hover:underline"
              onClick={() =>
                void client.updateSettings({ preferredServers: preferred.filter((x) => x !== p) })
              }
            >
              Remove
            </button>
          </div>
        ))}
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const clean = url.trim().replace(/\/$/, '');
            if (!/^https?:\/\//.test(clean))
              return client.reportError('Server URLs start with http:// or https://');
            void client.updateSettings({ preferredServers: [...preferred, clean] });
            setUrl('');
          }}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://croc.example.org"
          />
          <Button type="submit">Add</Button>
        </form>
      </div>
    </>
  );
}

function HostTab() {
  const [settings, setSettings] = useState<CoordinatorSettings | null>(null);
  const [status, setStatus] = useState<CoordinatorStatus>({ state: 'stopped' });
  useEffect(() => {
    if (!desktop) return;
    void desktop.coordinator.get().then((r) => {
      setSettings(r.settings);
      setStatus(r.status);
    });
    return desktop.coordinator.onStatus(setStatus);
  }, []);
  if (!desktop) return <p className="text-muted">Hosting a server needs the desktop app.</p>;
  if (!settings) return null;
  const update = async (patch: Partial<CoordinatorSettings>) =>
    setSettings(await desktop!.coordinator.set(patch));
  return (
    <>
      <H>Host a coordination server</H>
      <p className="mb-6 text-sm text-muted">
        Help the network by running a coordination server on this computer. It stores public
        profiles and space metadata (signed by their owners), introduces peers and picks call hosts.
        It never receives messages or voice. To serve the internet, forward the port on your router
        and set your public address below; otherwise it works on your local network.
      </p>
      <Toggle
        label="Run a coordination server"
        checked={settings.enabled}
        onChange={(v) => void update({ enabled: v })}
      />
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Server name</Label>
          <Input
            value={settings.name}
            maxLength={64}
            onChange={(e) => setSettings({ ...settings, name: e.target.value })}
            onBlur={() => void update({ name: settings.name })}
          />
        </div>
        <div>
          <Label>Port (TCP + UDP)</Label>
          <Input
            type="number"
            value={settings.port}
            onChange={(e) => setSettings({ ...settings, port: Number(e.target.value) })}
            onBlur={() => void update({ port: settings.port })}
          />
        </div>
      </div>
      <div className="mt-4">
        <Label>Public address (optional)</Label>
        <Input
          value={settings.publicUrl ?? ''}
          placeholder="http://203.0.113.7:7443 or https://croc.example.org"
          onChange={(e) => setSettings({ ...settings, publicUrl: e.target.value })}
          onBlur={() => void update({ publicUrl: settings.publicUrl?.trim() || undefined })}
        />
      </div>
      <div className="mt-4">
        <Toggle
          label="List in the public directory"
          hint="Lets other Crocodile users find and use your server. Requires a public address."
          checked={settings.announce}
          onChange={(v) => void update({ announce: v })}
        />
      </div>
      <div className="rounded-lg bg-side p-4 text-sm">
        <span className="font-semibold text-white">Status: </span>
        {status.state === 'running' ? (
          <span className="text-online">
            Running at {status.url} · {status.users} user{status.users === 1 ? '' : 's'} ·{' '}
            {status.peers} mesh peer{status.peers === 1 ? '' : 's'}
            {status.announced ? ' · listed' : ''}
          </span>
        ) : status.state === 'error' ? (
          <span className="text-dnd">{status.message}</span>
        ) : (
          <span className="text-muted">{status.state}</span>
        )}
      </div>
    </>
  );
}

function AboutTab() {
  const version = useUi((s) => s.appVersion);
  return (
    <>
      <H>About Crocodile</H>
      <p className="text-sm leading-relaxed text-muted">
        Crocodile {version}. Voice and text travel only between the people in a conversation,
        end-to-end encrypted. For groups, the member with the best connection is elected host and
        relays the encrypted streams; a runner-up stands by to take over instantly. Volunteer
        coordination servers handle introductions and never see content.
      </p>
    </>
  );
}
