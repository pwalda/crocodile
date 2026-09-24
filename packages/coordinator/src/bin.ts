#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Coordinator, defaultConfig } from './coordinator';

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'string' },
    'public-url': { type: 'string' },
    region: { type: 'string' },
    'data-dir': { type: 'string' },
    storage: { type: 'string' },
    directory: { type: 'string' },
    peers: { type: 'string' },
    'stun-port': { type: 'string' },
    stun: { type: 'string' },
    capacity: { type: 'string' },
    private: { type: 'boolean' },
    'log-level': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`crocodile-coordinator — Crocodile coordination server

Options (environment variable in brackets):
  --name <text>          display name                     [CROC_NAME]
  --host <addr>          bind address (0.0.0.0)           [CROC_HOST]
  --port <n>             HTTP/WebSocket port (7443)       [CROC_PORT]
  --public-url <url>     URL clients use to reach us      [CROC_PUBLIC_URL]
  --region <code>        e.g. eu-west                     [CROC_REGION]
  --data-dir <path>      persistent state                 [CROC_DATA_DIR]
  --storage sqlite|memory                                 [CROC_STORAGE]
  --directory <urls>     comma-separated directory URLs   [CROC_DIRECTORY]
  --peers <urls>         static mesh peers                [CROC_PEERS]
  --stun-port <n|off>    built-in STUN UDP port (7443)    [CROC_STUN_PORT]
  --stun <urls>          extra STUN URLs for clients      [CROC_STUN]
  --capacity <n>         max users advertised (5000)      [CROC_CAPACITY]
  --private              do not register with directory   [CROC_PRIVATE=1]
  --log-level <lvl>      debug|info|warn|error            [CROC_LOG_LEVEL]`);
  process.exit(0);
}

const env = process.env;
const pick = (flag: string | undefined, envName: string) => flag ?? env[envName];
const stunPort = pick(values['stun-port'], 'CROC_STUN_PORT');
const port = Number(pick(values.port, 'CROC_PORT') ?? defaultConfig.port);

const coordinator = new Coordinator({
  name: pick(values.name, 'CROC_NAME') ?? defaultConfig.name,
  host: pick(values.host, 'CROC_HOST') ?? defaultConfig.host,
  port,
  publicUrl: pick(values['public-url'], 'CROC_PUBLIC_URL'),
  region: pick(values.region, 'CROC_REGION'),
  dataDir: pick(values['data-dir'], 'CROC_DATA_DIR') ?? '.crocodile-data',
  storage: (pick(values.storage, 'CROC_STORAGE') as 'sqlite' | 'memory' | undefined) ?? 'sqlite',
  directoryUrls: list(pick(values.directory, 'CROC_DIRECTORY')),
  meshPeers: list(pick(values.peers, 'CROC_PEERS')),
  stunPort: stunPort === 'off' ? null : stunPort ? Number(stunPort) : port,
  extraStun: list(pick(values.stun, 'CROC_STUN')),
  capacity: Number(pick(values.capacity, 'CROC_CAPACITY') ?? defaultConfig.capacity),
  announce: !(values.private || env.CROC_PRIVATE === '1'),
  logLevel: (pick(values['log-level'], 'CROC_LOG_LEVEL') as never) ?? 'info',
});

await coordinator.start();
if (!coordinator.config.publicUrl && coordinator.config.announce && coordinator.config.directoryUrls.length) {
  coordinator.log.warn('no --public-url set; the directory will list a loopback URL that others cannot reach');
}

const shutdown = async () => {
  await coordinator.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
