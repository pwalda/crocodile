import { useId } from 'react';

/** Crocodile mark: an eye watching from just above the waterline. */
export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id={`bg${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#15523c" />
          <stop offset="1" stopColor="#0a2a20" />
        </linearGradient>
        <linearGradient id={`sk${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a7f3a0" />
          <stop offset="1" stopColor="#4fbf6a" />
        </linearGradient>
        <radialGradient id={`ir${id}`} cx="0.4" cy="0.35" r="0.7">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="1" stopColor="#f59e0b" />
        </radialGradient>
        <clipPath id={`ab${id}`}>
          <rect x="0" y="0" width="64" height="39" />
        </clipPath>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="17" fill={`url(#bg${id})`} />
      <g clipPath={`url(#ab${id})`}>
        <path d="M11 41 C12 25 22 17 32 17 C42 17 52 25 53 41 Z" fill={`url(#sk${id})`} />
        <path d="M22 20.5 l2.5 -4 l2.5 3.2 l2.6 -4.2 l2.4 4.2 l2.6 -3.2 l2.4 4" fill="#6fd17f" />
        <ellipse cx="32" cy="30.5" rx="8.2" ry="7.6" fill={`url(#ir${id})`} />
        <ellipse cx="32" cy="30.5" rx="1.9" ry="6.6" fill="#10231b" />
        <circle cx="29.2" cy="27.4" r="1.3" fill="#fffbe6" opacity="0.9" />
      </g>
      <path
        d="M6 39.5 C12 37 16 42 22 39.5 S32 37 38 39.5 S48 42 58 39"
        stroke="#5eead4"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
        opacity="0.9"
      />
      <path
        d="M10 46 C15 44 19 48 25 46 S35 44 41 46 S50 48 55 46"
        stroke="#5eead4"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        opacity="0.45"
      />
    </svg>
  );
}

/** Just the eye, for small places (tabs, empty states). */
export function EyeMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M2 15 C4 7 9 4 12 4 C15 4 20 7 22 15 Z" fill="currentColor" opacity="0.25" />
      <ellipse cx="12" cy="11" rx="4.4" ry="4.1" fill="#f5b53d" />
      <ellipse cx="12" cy="11" rx="1" ry="3.6" fill="#10231b" />
      <path
        d="M1 16 C4 14.5 6 17.5 9 16 S15 14.5 18 16 S21 17 23 16"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
