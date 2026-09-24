import {
  useEffect,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { colorFor, initials } from '../lib/format';
import { useCroc } from '../croc';
import type { PresenceStatus } from '@crocodile/protocol';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-croc text-white hover:bg-croc-dark',
    secondary: 'bg-active text-text hover:bg-[#4e5058]',
    danger: 'bg-danger text-white hover:bg-[#a12828]',
    ghost: 'bg-transparent text-text hover:underline',
  };
  return (
    <button
      {...props}
      className={cx(
        'inline-flex h-9 items-center justify-center gap-2 rounded px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'selectable h-10 w-full rounded bg-float px-3 text-[15px] text-text placeholder:text-faint outline-none focus:ring-2 focus:ring-croc/60',
        className,
      )}
    />
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">{children}</div>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onMouseDown={onClose}
    >
      <div
        className={cx(
          'pop-in relative max-h-[90vh] overflow-hidden rounded-lg bg-main shadow-2xl',
          wide ? 'w-[640px]' : 'w-[440px]',
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="absolute right-3 top-3 text-muted hover:text-text"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={22} />
        </button>
        {title && (
          <div className="px-6 pt-6 text-center">
            <h2 className="text-2xl font-bold text-white">{title}</h2>
            {subtitle && <p className="mt-2 text-[15px] text-muted">{subtitle}</p>}
          </div>
        )}
        <div className="max-h-[65vh] overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 bg-side px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<PresenceStatus, string> = {
  online: 'bg-online',
  idle: 'bg-idle',
  dnd: 'bg-dnd',
  offline: 'bg-faint',
};

export function StatusDot({
  status,
  className,
  size = 14,
}: {
  status: PresenceStatus;
  className?: string;
  size?: number;
}) {
  return (
    <span
      className={cx('block rounded-full border-side', STATUS_COLOR[status], className)}
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 5)) }}
    />
  );
}

export function Avatar({
  userId,
  size = 32,
  status,
  speaking,
  className,
}: {
  userId: string;
  size?: number;
  status?: PresenceStatus | 'auto';
  speaking?: boolean;
  className?: string;
}) {
  const profile = useCroc((s) => s.profiles[userId]);
  const presence = useCroc((s) =>
    userId === s.me?.userId
      ? s.link === 'connected'
        ? s.settings.status === 'invisible'
          ? 'offline'
          : s.settings.status
        : 'offline'
      : (s.presence[userId] ?? 'offline'),
  );
  const name = profile?.username ?? '…';
  const shown = status === 'auto' ? (presence as PresenceStatus) : status;
  return (
    <div className={cx('relative shrink-0', className)} style={{ width: size, height: size }}>
      <div
        className={cx(
          'flex h-full w-full items-center justify-center overflow-hidden rounded-full text-white',
          speaking && 'speaking-ring',
        )}
        style={{
          background: profile?.avatar ? undefined : colorFor(userId),
          fontSize: size * 0.38,
        }}
      >
        {profile?.avatar ? (
          <img
            src={profile.avatar}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          initials(name)
        )}
      </div>
      {shown && (
        <StatusDot
          status={shown}
          size={Math.max(10, Math.round(size * 0.38))}
          className="absolute -bottom-0.5 -right-0.5"
        />
      )}
    </div>
  );
}

export function UserName({ userId, className }: { userId: string; className?: string }) {
  const name = useCroc((s) => s.profiles[userId]?.username);
  return <span className={className}>{name ?? 'Unknown user'}</span>;
}

export function IconButton({
  label,
  children,
  active,
  danger,
  onClick,
  className,
}: {
  label: string;
  children: ReactNode;
  active?: boolean;
  danger?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cx(
        'flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-hover',
        danger ? 'text-dnd' : active ? 'text-text' : 'text-muted hover:text-text',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Toasts() {
  const errors = useCroc((s) => s.errors);
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {errors.map((e) => (
        <div
          key={e.id}
          className="pop-in pointer-events-auto rounded-md bg-danger px-4 py-2 text-sm font-medium text-white shadow-lg"
        >
          {e.message}
        </div>
      ))}
    </div>
  );
}
