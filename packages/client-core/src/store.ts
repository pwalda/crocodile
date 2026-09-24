/** Tiny observable state container (works with React's useSyncExternalStore). */
export class StateStore<T extends object> {
  private listeners = new Set<() => void>();
  private scheduled = false;

  constructor(private state: T) {}

  get = (): T => this.state;

  set(update: Partial<T> | ((s: T) => Partial<T>)) {
    const patch = typeof update === 'function' ? update(this.state) : update;
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private notify() {
    // Coalesce bursts of updates into one render.
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const fn of [...this.listeners]) fn();
    });
  }
}
