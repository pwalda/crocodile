/** Minimal typed event emitter that works in every JS runtime. */
export class Emitter<Events extends { [K in keyof Events]: unknown }> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => this.off(event, fn);
  }

  once<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void) {
    this.handlers.get(event)?.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]) {
    for (const fn of [...(this.handlers.get(event) ?? [])]) {
      try {
        (fn as (p: Events[K]) => void)(payload);
      } catch (err) {
        console.error(`handler for ${String(event)} failed`, err);
      }
    }
  }

  removeAll() {
    this.handlers.clear();
  }
}
