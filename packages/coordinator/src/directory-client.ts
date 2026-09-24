import { openDirectoryEntry } from '@crocodile/crypto';
import { DIRECTORY_PATHS, type DirectoryListing } from '@crocodile/protocol';
import type { Coordinator } from './coordinator';

const REGISTER_INTERVAL_MS = 60_000;

/** Keeps this server registered with the directory and feeds its listing to the mesh. */
export class DirectoryClient {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly hub: Coordinator,
    private readonly urls: string[],
  ) {}

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), REGISTER_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    for (const base of this.urls) {
      const root = base.replace(/\/$/, '');
      try {
        if (this.hub.config.announce) {
          const res = await fetch(root + DIRECTORY_PATHS.register, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(this.hub.directoryEntry()),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok)
            this.hub.log.warn('directory rejected registration', {
              directory: root,
              status: res.status,
              body: await res.text(),
            });
        }
        const listing = (await (
          await fetch(root + DIRECTORY_PATHS.list, { signal: AbortSignal.timeout(10_000) })
        ).json()) as DirectoryListing;
        this.hub.mesh.addKnown(
          listing.servers
            .map((raw) => openDirectoryEntry(raw)?.server)
            .filter((s): s is NonNullable<typeof s> => !!s),
        );
      } catch (err) {
        this.hub.log.warn('directory unreachable', { directory: root, err: String(err) });
      }
    }
  }
}
