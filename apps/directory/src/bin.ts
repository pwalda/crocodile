#!/usr/bin/env node
import { Directory, defaultDirectoryConfig } from './index';

const env = process.env;
const directory = new Directory({
  host: env.CROC_DIR_HOST ?? defaultDirectoryConfig.host,
  port: Number(env.CROC_DIR_PORT ?? defaultDirectoryConfig.port),
  allowPrivateUrls: env.CROC_DIR_ALLOW_PRIVATE === '1',
  verifyReachability: env.CROC_DIR_VERIFY !== '0',
  trustProxy: env.CROC_DIR_TRUST_PROXY === '1',
  statePath: env.CROC_DIR_STATE ?? '.crocodile-data/directory.json',
  log: (m) => console.log(`${new Date().toISOString()} [directory] ${m}`),
});
await directory.start();
console.log(`${new Date().toISOString()} [directory] listening on port ${directory.config.port}`);

const shutdown = async () => {
  await directory.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
