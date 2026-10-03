#!/usr/bin/env node
/**
 * Launch one desktop app instance per name, each with its own profile in
 * ~/.crocodile-qa/<name>, pointed at the local QA directory (pnpm qa:env).
 *
 *   pnpm qa:app alice bob          # two people on this machine
 *   pnpm qa:app alice --reset      # start alice from scratch
 *   pnpm qa:app carol --no-directory   # simulate "no server list" (first run)
 *   pnpm qa:app dave --fake-media      # fake microphone/camera (headless voice tests)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const appDir = join(root, 'apps/desktop');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const names = args.filter((a) => !a.startsWith('--'));
if (names.length === 0) names.push('alice');

if (!existsSync(join(appDir, 'dist/main/main.cjs')) || flags.has('--build')) {
  console.log('Building the desktop app…');
  const r = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: appDir, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const electron = createRequire(join(appDir, 'package.json'))('electron');
for (const name of names) {
  const profile = join(homedir(), '.crocodile-qa', name);
  if (flags.has('--reset')) rmSync(profile, { recursive: true, force: true });
  const extra = [
    // Chromium refuses to run as root (containers, CI) without this.
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ...(flags.has('--fake-media')
      ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
      : []),
  ];
  const child = spawn(electron, [appDir, ...extra], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CROC_USER_DATA: profile,
      CROC_DIRECTORIES_OVERRIDE: flags.has('--no-directory') ? '' : 'http://127.0.0.1:7400',
    },
  });
  console.log(`${name}: profile ${profile} (pid ${child.pid})`);
}
