import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Home, MessageSquareText, Plus, Settings, User, Users } from 'lucide-react';
import { getClient, navigate, openModal, ui, useCroc, useUi } from '../croc';
import { cx } from './ui';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

/** Ctrl+K: jump anywhere by typing. */
export function CommandPalette() {
  const open = useUi((s) => s.palette);
  const spaces = useCroc((s) => s.spaces);
  const friends = useCroc((s) => s.friends.friends);
  const dms = useCroc((s) => s.dms);
  const profiles = useCroc((s) => s.profiles);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.set({ palette: !ui.get().palette });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        openModal({ kind: 'settings' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const close = () => ui.set({ palette: false });
    const out: Item[] = [
      {
        id: 'home',
        label: 'People',
        hint: 'Home',
        icon: <Home size={16} />,
        run: () => navigate({ kind: 'friends' }),
      },
      {
        id: 'new-space',
        label: 'Create or join a space',
        icon: <Plus size={16} />,
        run: () => openModal({ kind: 'add-space' }),
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: <Settings size={16} />,
        run: () => openModal({ kind: 'settings' }),
      },
    ];
    for (const s of Object.values(spaces)) {
      out.push({
        id: `s:${s.id}`,
        label: s.name,
        hint: 'Space',
        icon: <Users size={16} />,
        run: () =>
          navigate({
            kind: 'space',
            spaceId: s.id,
            channelId: s.channels.find((c) => c.kind === 'text')?.id ?? null,
          }),
      });
      for (const c of s.channels) {
        out.push({
          id: `c:${c.id}`,
          label: c.name,
          hint: `${c.kind === 'voice' ? 'Room' : 'Channel'} · ${s.name}`,
          icon: c.kind === 'voice' ? <AudioLines size={16} /> : <MessageSquareText size={16} />,
          run: () => {
            navigate({ kind: 'space', spaceId: s.id, channelId: c.id });
            if (c.kind === 'voice')
              void getClient()
                .joinVoice(s.id, c.id)
                .catch((e) => getClient().reportError(e.message));
          },
        });
      }
    }
    for (const u of new Set([...dms, ...friends])) {
      out.push({
        id: `u:${u}`,
        label: profiles[u]?.username ?? u,
        hint: 'Conversation',
        icon: <User size={16} />,
        run: () => navigate({ kind: 'dm', userId: u }),
      });
    }
    return out.map((i) => ({
      ...i,
      run: () => {
        close();
        i.run();
      },
    }));
  }, [spaces, friends, dms, profiles]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items.slice(0, 12);
    return items
      .map((i) => ({
        i,
        score:
          score(i.label.toLowerCase(), needle) + (i.hint?.toLowerCase().includes(needle) ? 1 : 0),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((x) => x.i);
  }, [items, q]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 pt-[14vh] backdrop-blur-sm"
      onMouseDown={() => ui.set({ palette: false })}
    >
      <div
        className="island rise w-[560px] overflow-hidden rounded-3xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') ui.set({ palette: false });
            if (e.key === 'ArrowDown') setSel((s) => Math.min(filtered.length - 1, s + 1));
            if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
            if (e.key === 'Enter') filtered[sel]?.run();
          }}
          placeholder="Where to? Spaces, rooms, channels, people…"
          className="w-full border-b border-line bg-transparent px-6 py-5 text-[16px] outline-none placeholder:text-faint"
        />
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {filtered.length === 0 && (
            <p className="p-6 text-center text-sm text-muted">No matches.</p>
          )}
          {filtered.map((item, i) => (
            <button
              key={item.id}
              onMouseEnter={() => setSel(i)}
              onClick={item.run}
              className={cx(
                'flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left text-[14px]',
                i === sel ? 'bg-accent-soft text-text' : 'text-text-2',
              )}
            >
              <span className={i === sel ? 'text-accent' : 'text-faint'}>{item.icon}</span>
              <span className="flex-1 truncate font-semibold">{item.label}</span>
              {item.hint && <span className="text-xs text-faint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Tiny fuzzy score: prefix > word start > substring > subsequence. */
function score(text: string, needle: string): number {
  if (text.startsWith(needle)) return 4;
  if (text.split(/[\s#-]/).some((w) => w.startsWith(needle))) return 3;
  if (text.includes(needle)) return 2;
  let j = 0;
  for (const ch of text) if (ch === needle[j]) j++;
  return j === needle.length ? 1 : 0;
}
