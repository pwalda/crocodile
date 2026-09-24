import { useState } from 'react';
import { Check, Copy, KeyRound, ShieldCheck, Sparkles } from 'lucide-react';
import { getClient } from '../croc';
import { copyText, imageToDataUrl } from '../lib/format';
import { Button, Input, Label } from './ui';
import { Logo } from './Logo';

type Step = 'welcome' | 'create' | 'restore' | 'recovery';

/** First run: no accounts, passwords or emails. Pick a name and you are in. */
export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string | undefined>();
  const [recovery, setRecovery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [savedKey, setSavedKey] = useState(false);

  const client = getClient();

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.createAccount(name.trim(), avatar);
      setRecovery(client.recoveryKey());
      setStep('recovery');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.restoreAccount(recovery, name.trim() || undefined);
      client.finishOnboarding();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const finish = () => client.finishOnboarding();

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-[#0f2a1f] via-rail to-[#1a1033]">
      <div className="pop-in w-[480px] rounded-xl bg-main p-8 shadow-2xl">
        {step === 'welcome' && (
          <div className="text-center">
            <Logo size={72} className="mx-auto" />
            <h1 className="mt-4 text-3xl font-bold text-white">Welcome to Crocodile</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              Voice and text chat that goes straight from you to your friends. Everything is end-to-end encrypted and never stored on
              anyone's server.
            </p>
            <div className="mt-8 flex flex-col gap-3">
              <Button className="h-11 text-base" onClick={() => setStep('create')}>
                <Sparkles size={18} /> Get started
              </Button>
              <Button variant="secondary" className="h-11" onClick={() => setStep('restore')}>
                <KeyRound size={18} /> I have a recovery key
              </Button>
            </div>
          </div>
        )}

        {step === 'create' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void create();
            }}
          >
            <h2 className="text-center text-2xl font-bold text-white">What should everyone call you?</h2>
            <p className="mt-2 text-center text-sm text-muted">You can change this any time.</p>
            <div className="mt-6 flex items-center gap-4">
              <label className="group relative flex h-20 w-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-croc text-3xl font-bold text-white">
                {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : (name.trim()[0] ?? '🐊').toUpperCase()}
                <span className="absolute inset-0 hidden items-center justify-center bg-black/50 text-xs font-bold group-hover:flex">CHANGE</span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) setAvatar(await imageToDataUrl(f));
                  }}
                />
              </label>
              <div className="flex-1">
                <Label>Display name</Label>
                <Input autoFocus maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Wally" />
              </div>
            </div>
            {error && <p className="mt-4 text-sm text-dnd">{error}</p>}
            <div className="mt-8 flex justify-between">
              <Button type="button" variant="ghost" onClick={() => setStep('welcome')}>
                Back
              </Button>
              <Button type="submit" disabled={!name.trim() || busy}>
                {busy ? 'Setting up…' : 'Continue'}
              </Button>
            </div>
          </form>
        )}

        {step === 'recovery' && (
          <div>
            <div className="text-center">
              <ShieldCheck size={48} className="mx-auto text-croc" />
              <h2 className="mt-3 text-2xl font-bold text-white">Save your recovery key</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                There are no passwords. This key <b className="text-text">is</b> your account: use it to sign in on another device or if
                you reinstall. Keep it somewhere safe and never share it.
              </p>
            </div>
            <div className="selectable mt-5 break-all rounded-md bg-float p-4 text-center font-mono text-[15px] tracking-wide text-croc-light">
              {recovery}
            </div>
            <div className="mt-3 flex justify-center">
              <Button
                variant="secondary"
                onClick={async () => {
                  await copyText(recovery);
                  setCopied(true);
                }}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy key'}
              </Button>
            </div>
            <label className="mt-6 flex cursor-pointer items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={savedKey} onChange={(e) => setSavedKey(e.target.checked)} className="accent-croc" />
              I saved my recovery key
            </label>
            <Button className="mt-4 h-11 w-full" disabled={!savedKey} onClick={finish}>
              Start chatting
            </Button>
          </div>
        )}

        {step === 'restore' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void restore();
            }}
          >
            <h2 className="text-center text-2xl font-bold text-white">Welcome back</h2>
            <p className="mt-2 text-center text-sm text-muted">Paste the recovery key you saved when you created your account.</p>
            <div className="mt-6">
              <Label>Recovery key</Label>
              <Input autoFocus value={recovery} onChange={(e) => setRecovery(e.target.value)} placeholder="XXXX-XXXX-…" className="font-mono" />
            </div>
            {error && <p className="mt-4 text-sm text-dnd">{error}</p>}
            <div className="mt-8 flex justify-between">
              <Button type="button" variant="ghost" onClick={() => setStep('welcome')}>
                Back
              </Button>
              <Button type="submit" disabled={recovery.replace(/[^a-z2-7]/gi, '').length < 50 || busy}>
                {busy ? 'Restoring…' : 'Restore'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
