/**
 * Local QA network: a directory plus a mesh of coordination servers on this
 * machine, with the relay and mailbox enabled. Keep it running and start app
 * instances with `pnpm qa:app alice bob` (each gets its own profile).
 *
 *   pnpm qa:env                  # directory :7400, servers :7443 :7444 :7445
 *   pnpm qa:env --servers 1      # a single coordination server
 *   pnpm qa:env --persist        # keep server state in ~/.crocodile-qa/servers
 */
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Directory } from '@crocodile/directory';
import { Coordinator } from '@crocodile/coordinator';

const { values } = parseArgs({
  options: {
    servers: { type: 'string', default: '3' },
    persist: { type: 'boolean', default: false },
    'base-port': { type: 'string', default: '7443' },
  },
});
const count = Math.max(1, Math.min(6, Number(values.servers)));
const basePort = Number(values['base-port']);
const dataRoot = join(homedir(), '.crocodile-qa', 'servers');

const directory = await new Directory({
  host: '127.0.0.1',
  port: 7400,
  allowPrivateUrls: true,
  statePath: values.persist ? join(dataRoot, 'directory.json') : undefined,
}).start();

const servers: Coordinator[] = [];
for (let i = 0; i < count; i++) {
  const port = basePort + i;
  const name = `QA ${String.fromCharCode(65 + i)}`;
  const c = await new Coordinator({
    name,
    host: '0.0.0.0',
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    storage: values.persist ? 'sqlite' : 'memory',
    ...(values.persist ? { dataDir: join(dataRoot, `server-${i}`) } : {}),
    stunPort: port,
    directoryUrls: [directory.url],
    meshPeers: servers.map((s) => s.url),
    announce: true,
    logLevel: 'info',
    // Everything is on this machine, so the relay must reach loopback.
    relay: { enabled: true, maxUsers: 10, allowPrivatePeers: true },
  }).start();
  servers.push(c);
}

console.log(`
Crocodile QA network is up.

  Directory       ${directory.url}
${servers.map((s) => `  ${s.config.name.padEnd(15)} ${s.url}  (UDP ${s.config.stunPort}: STUN, relay)`).join('\n')}

Start app instances (each with its own profile):
  pnpm qa:app alice bob

Other devices on your network can join with Settings → Network →
Preferred servers: http://<this machine's LAN address>:${basePort}

Ctrl+C to stop.`);

const stop = async () => {
  for (const s of servers.reverse()) await s.stop().catch(() => {});
  await directory.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
