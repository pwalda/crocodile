/**
 * Drives two real Electron instances through onboarding, space creation,
 * invites, chat and voice against a local directory + coordinator, taking
 * screenshots along the way. Run: xvfb-run -a npx tsx tests/electron/smoke.ts <outdir>
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Directory } from '@crocodile/directory';
import { Coordinator } from '@crocodile/coordinator';

const out = process.argv[2] ?? join(tmpdir(), 'croc-shots');
mkdirSync(out, { recursive: true });
const appDir = join(import.meta.dirname, '../../apps/desktop');
const require = createRequire(join(appDir, 'package.json'));
const electronPath = require('electron') as unknown as string;

const directory = await new Directory({
  host: '127.0.0.1',
  port: 0,
  allowPrivateUrls: true,
}).start();
const coordinator = await new Coordinator({
  name: 'Local test coordinator',
  host: '127.0.0.1',
  port: 0,
  storage: 'memory',
  stunPort: 0,
  directoryUrls: [directory.url],
  announce: true,
  logLevel: 'warn',
}).start();
await new Promise((r) => setTimeout(r, 1000));

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  // CROC_APP_EXEC points at a packaged build (e.g. release/linux-unpacked/crocodile).
  const packaged = process.env.CROC_APP_EXEC;
  const app = await electron.launch({
    executablePath: packaged ?? electronPath,
    args: [
      ...(packaged ? [] : [appDir]),
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
    env: {
      ...process.env,
      CROC_USER_DATA: mkdtempSync(join(tmpdir(), `croc-${name}-`)),
      CROC_DIRECTORIES_OVERRIDE: directory.url,
    },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  page.on('pageerror', (e) => console.log(`[${name} pageerror] ${e.message}`));
  return { app, page };
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`screenshot ${name}`);
}

async function onboard(page: Page, name: string) {
  await page.getByText('Get started').click();
  await page.getByPlaceholder('e.g. Wally').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Save your recovery key').waitFor();
  return page;
}

const a = await launch('alice');
await shot(a.page, '01-welcome');
await onboard(a.page, 'Alice');
await shot(a.page, '02-recovery-key');
await a.page.getByText('I saved my recovery key').click();
await a.page.getByRole('button', { name: 'Start chatting' }).click();
await a.page.getByText('Add Friend').waitFor();
await a.page.waitForFunction(() => document.body.innerText.includes('#'), undefined, {
  timeout: 15_000,
});
await shot(a.page, '03-home');

// Create a space.
await a.page.getByLabel('Add a space').click();
await a.page.getByText('Create my own').click();
await a.page.getByRole('textbox').fill('The Swamp');
await a.page.getByRole('button', { name: 'Create' }).click();
await a.page.getByText('Welcome to #general!').waitFor({ timeout: 15_000 });
await shot(a.page, '04-space');

// Invite.
await a.page.getByText('The Swamp').first().click();
await a.page.getByText('Invite people').click();
await a.page.waitForFunction(
  () => /croc:\/\/join\/[a-z2-7]+/.test(document.body.innerText),
  undefined,
  { timeout: 15_000 },
);
const inviteText = await a.page.evaluate(
  () => document.body.innerText.match(/croc:\/\/join\/[a-z2-7]+/)![0],
);
await shot(a.page, '05-invite');
await a.page.keyboard.press('Escape');

// Bob joins.
const b = await launch('bob');
await onboard(b.page, 'Bob');
await b.page.getByText('I saved my recovery key').click();
await b.page.getByRole('button', { name: 'Start chatting' }).click();
await b.page.getByLabel('Add a space').click();
await b.page.getByRole('button', { name: 'Join a space' }).click();
await b.page.getByPlaceholder('croc://join/abcd2345').fill(inviteText);
await b.page.getByRole('button', { name: 'Join space' }).click();
await b.page.getByText('Welcome to #general!').waitFor({ timeout: 15_000 });

// Chat both ways.
await a.page.waitForFunction(
  () => /2 peers? online|1 peer online/.test(document.body.innerText),
  undefined,
  { timeout: 20_000 },
);
await a.page.getByPlaceholder('Message #general').fill('Hi Bob! This never touches a server 🐊');
await a.page.keyboard.press('Enter');
await b.page.getByText('This never touches a server').waitFor({ timeout: 15_000 });
await b.page
  .getByPlaceholder('Message #general')
  .fill('Wow, **end-to-end** and peer-to-peer. `nice`');
await b.page.keyboard.press('Enter');
await a.page.getByText('peer-to-peer.').waitFor({ timeout: 15_000 });
await shot(a.page, '06-chat');

// Voice.
await a.page.getByText('General', { exact: true }).click();
await b.page.getByText('General', { exact: true }).click();
await a.page.waitForFunction(() => document.body.innerText.includes('Voice Connected'), undefined, {
  timeout: 30_000,
});
await b.page.waitForFunction(() => document.body.innerText.includes('Voice Connected'), undefined, {
  timeout: 30_000,
});
await a.page.waitForTimeout(2000);
await shot(a.page, '07-voice');
await shot(b.page, '08-voice-bob');

// Friends + settings screens.
await b.page.getByLabel('Direct messages').click();
await b.page.getByText('Add Friend').click();
await b.page.getByPlaceholder('You can add friends with their name#tag.').fill('alice');
await b.page.getByRole('button', { name: 'Search' }).click();
await b.page.getByText('Send friend request').waitFor({ timeout: 10_000 });
await shot(b.page, '09-add-friend');
await b.page.getByText('Send friend request').click();
await a.page.getByLabel('Direct messages').click();
await a.page.getByText('Pending').click();
await a.page.getByText('Incoming friend request').waitFor({ timeout: 10_000 });
await shot(a.page, '10-friend-request');
await a.page.getByLabel('User settings').click();
await a.page.getByText('Voice & Audio').click();
await shot(a.page, '11-settings-voice');
await a.page.getByText('Connection', { exact: true }).click();
await shot(a.page, '12-settings-connection');

console.log('SMOKE OK');
await a.app.close();
await b.app.close();
await coordinator.stop();
await directory.stop();
process.exit(0);
