/** Crocodile mark: a stylised croc head in a rounded square. */
export function Logo({ size = 48, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="18" fill="#2fa56f" />
      <path
        d="M12 38c6-9 16-14 28-14 5 0 9 1 12 3l-4 3 4 2-5 2 3 3c-4 3-10 4-17 4-9 0-16-1-21-3z"
        fill="#e8fff3"
      />
      <circle cx="40" cy="30" r="2.6" fill="#16372a" />
      <path
        d="M22 41l2-3 2 3 2-3 2 3 2-3 2 3"
        stroke="#2fa56f"
        strokeWidth="1.6"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}
