import { useId } from 'react';

const HEAD = 'M12 38c6-9 16-14 28-14 5 0 9 1 12 3l-4 3 4 2-5 2 3 3c-4 3-10 4-17 4-9 0-16-1-21-3z';
const TEETH = 'M22 41l2-3 2 3 2-3 2 3 2-3 2 3';

/** Crocodile mark: a stylised croc head in a rounded square (same as the app icon). */
export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#37b97c" />
          <stop offset="1" stopColor="#1f7f55" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill={`url(#g${id})`} />
      <path d={HEAD} fill="#e8fff3" />
      <circle cx="40" cy="30" r="2.6" fill="#16372a" />
      <path d={TEETH} stroke="#2fa56f" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

/** Just the croc head in the current text colour, for empty states. */
export function CrocMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="8 14 48 34" className={className} aria-hidden>
      <path d={HEAD} fill="currentColor" opacity="0.9" />
      <circle cx="40" cy="30" r="2.6" fill="var(--island)" />
      <path d={TEETH} stroke="var(--island)" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
    </svg>
  );
}
