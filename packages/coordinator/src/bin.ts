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
    relay: { type: 'string' },
    'relay-max-users': { type: 'string' },
    'relay-ip': { type: 'string' },
    'relay-allow-private': { type: 'boolean' },
    mailbox: { type: 'string' },
    source: { type: 'string' },
    'trust-proxy': { type: 'boolean' },
    'max-connections-per-ip': { type: 'string' },
    'mailbox-days': { type: 'string' },
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
  --relay on|off         opt-in relay for blocked users   [CROC_RELAY]
  --relay-max-users <n>  concurrent relay users (25)      [CROC_RELAY_MAX_USERS]
  --relay-ip <addr>      public IP for relay candidates   [CROC_RELAY_IP]
  --relay-allow-private  let the relay reach private and  [CROC_RELAY_ALLOW_PRIVATE=1]
                         loopback addresses (LAN-only
                         deployments; unsafe on the internet)
  --mailbox on|off       hold sealed mail for offline     [CROC_MAILBOX]
                         devices (opt-in for users)
  --mailbox-days <n>     how long mail is kept, max 7 (3) [CROC_MAILBOX_DAYS]
  --trust-proxy          read client IPs from             [CROC_TRUST_PROXY=1]
                         X-Forwarded-For (behind a proxy)
  --max-connections-per-ip <n>  per-address limit (50)    [CROC_MAX_CONN_PER_IP]
  --source <url>         where users get this server's    [CROC_SOURCE_URL]
                         source (required by the AGPL if
                         you run a modified version)
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
  relay: {
    enabled: (pick(values.relay, 'CROC_RELAY') ?? 'on') !== 'off',
    maxUsers: Number(
      pick(values['relay-max-users'], 'CROC_RELAY_MAX_USERS') ?? defaultConfig.relay.maxUsers,
    ),
    publicIp: pick(values['relay-ip'], 'CROC_RELAY_IP'),
    allowPrivatePeers:
      values['relay-allow-private'] === true || env.CROC_RELAY_ALLOW_PRIVATE === '1',
  },
  sourceUrl: pick(values.source, 'CROC_SOURCE_URL'),
  trustProxy: values['trust-proxy'] === true || env.CROC_TRUST_PROXY === '1',
  maxConnectionsPerIp: Number(
    pick(values['max-connections-per-ip'], 'CROC_MAX_CONN_PER_IP') ??
      defaultConfig.maxConnectionsPerIp,
  ),
  mailbox: {
    ...defaultConfig.mailbox,
    enabled: (pick(values.mailbox, 'CROC_MAILBOX') ?? 'on') !== 'off',
    ttlMs:
      Math.min(7, Number(pick(values['mailbox-days'], 'CROC_MAILBOX_DAYS') ?? 3)) * 24 * 3600_000,
  },
  logLevel: (pick(values['log-level'], 'CROC_LOG_LEVEL') as never) ?? 'info',
});

await coordinator.start();
if (
  !coordinator.config.publicUrl &&
  coordinator.config.announce &&
  coordinator.config.directoryUrls.length
) {
  coordinator.log.warn(
    'no --public-url set; the directory will list a loopback URL that others cannot reach',
  );
}

const shutdown = async () => {
  await coordinator.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
