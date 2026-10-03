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

async function launch(
  name: string,
  opts: { noDirectory?: boolean } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
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
      CROC_DIRECTORIES_OVERRIDE: opts.noDirectory ? '' : directory.url,
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
  await page.getByText("I'm new here").click();
  await page.getByPlaceholder('e.g. Wally').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Keep your recovery key').waitFor();
  return page;
}

async function finishOnboarding(page: Page) {
  await page.getByText('I saved my recovery key').click();
  await page.getByRole('button', { name: 'Start talking' }).click();
  await page.getByText('Add someone').waitFor();
}

const a = await launch('alice');
await shot(a.page, '01-welcome');
await onboard(a.page, 'Alice');
await shot(a.page, '02-recovery-key');
await finishOnboarding(a.page);
await a.page.waitForFunction(() => /Alice#\d+/.test(document.body.innerText), undefined, {
  timeout: 15_000,
});
await shot(a.page, '03-home');

// Create a space.
await a.page.getByTitle('Create or join a space').click();
await a.page.getByText('Create my own').click();
await a.page.getByRole('dialog').getByRole('textbox').fill('The Swamp');
await a.page.getByRole('button', { name: 'Create' }).click();
await a.page.getByText('This is the start of general').waitFor({ timeout: 15_000 });
await shot(a.page, '04-space');

// Invite.
await a.page.getByRole('button', { name: 'Invite people' }).click();
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
await finishOnboarding(b.page);
await b.page.getByTitle('Create or join a space').click();
await b.page.getByRole('button', { name: 'Join a space' }).click();
await b.page.getByPlaceholder('croc://join/abcd2345').fill(inviteText);
await b.page.getByRole('button', { name: 'Join space' }).click();
await b.page.getByText('This is the start of general').waitFor({ timeout: 15_000 });

// Chat both ways.
await a.page.waitForFunction(
  () => /[12] peers? connected/.test(document.body.innerText),
  undefined,
  { timeout: 20_000 },
);
await a.page.getByPlaceholder('Message general').fill('Hi Bob! This never touches a server 🐊');
await a.page.keyboard.press('Enter');
await b.page.getByText('This never touches a server').waitFor({ timeout: 15_000 });
await b.page
  .getByPlaceholder('Message general')
  .fill('Wow, **end-to-end** and peer-to-peer. `nice`');
await b.page.keyboard.press('Enter');
await a.page.getByText('peer-to-peer.').waitFor({ timeout: 15_000 });
await shot(a.page, '06-chat');

// Voice room.
const inCall = (page: Page) =>
  page.waitForFunction(() => /you host|hosted by/.test(document.body.innerText), undefined, {
    timeout: 30_000,
  });
await a.page.getByText('General', { exact: true }).click();
await b.page.getByText('General', { exact: true }).click();
await inCall(a.page);
await inCall(b.page);
await a.page.waitForTimeout(2000);
await shot(a.page, '07-voice');
await shot(b.page, '08-voice-bob');

// People.
await b.page.getByRole('button', { name: 'Home' }).click();
await b.page.getByPlaceholder('name#1234').fill('alice');
await b.page.getByRole('button', { name: 'Search' }).click();
await b.page.getByRole('button', { name: 'Add friend' }).waitFor({ timeout: 10_000 });
await shot(b.page, '09-add-friend');
await b.page.getByRole('button', { name: 'Add friend' }).click();
await a.page.getByRole('button', { name: 'Home' }).click();
await a.page.getByRole('button', { name: /Requests/ }).click();
await a.page.getByText('Wants to be friends').waitFor({ timeout: 10_000 });
await shot(a.page, '10-friend-request');

// Command palette + settings.
await a.page.keyboard.press('Control+K');
await a.page.waitForTimeout(200);
await shot(a.page, '11-palette');
await a.page.keyboard.press('Escape');
await a.page.getByLabel('Account').click();
await a.page.getByText('Settings', { exact: true }).click();
await a.page.getByRole('button', { name: 'Voice' }).click();
await shot(a.page, '12-settings-voice');
await a.page.getByRole('button', { name: 'Network' }).click();
await shot(a.page, '13-settings-network');
await a.page.getByRole('button', { name: 'Appearance' }).click();
await a.page.getByRole('button', { name: 'Lagoon' }).click();
await shot(a.page, '14-settings-dark');
// Bug-report diagnostics: copied as JSON, without message content.
await a.page.getByRole('button', { name: 'About' }).click();
await a.page.getByRole('button', { name: 'Copy diagnostics' }).click();
await a.page.getByText('Copied').first().waitFor();
const report = JSON.parse(await a.app.evaluate(({ clipboard }) => clipboard.readText()));
if (report.connection.link !== 'connected' || !Array.isArray(report.recentLog))
  throw new Error('diagnostics report is incomplete');
if (JSON.stringify(report).includes('This never touches a server'))
  throw new Error('diagnostics must not contain message content');
await a.page.getByRole('button', { name: 'Close settings' }).click();
await a.page.getByRole('button', { name: 'The Swamp' }).click();
await shot(a.page, '15-dark-chat');

// Link a second device to Alice's account.
const c = await launch('alice-laptop');
await c.page.getByText('I already use Crocodile').click();
await c.page.getByText('Link from another device').click();
await c.page.waitForFunction(() => /\b[A-Z2-7]{8}\b/.test(document.body.innerText), undefined, {
  timeout: 15_000,
});
const linkCode = await c.page.evaluate(() => document.body.innerText.match(/\b[A-Z2-7]{8}\b/)![0]);
await shot(c.page, '16-link-new-device');
await a.page.getByLabel('Account').click();
await a.page.getByText('Link another device').click();
await a.page.getByPlaceholder('ABCD2345').fill(linkCode);
await a.page.getByRole('button', { name: 'Continue' }).click();
await a.page.getByText('They match').waitFor({ timeout: 10_000 });
await shot(a.page, '17-link-confirm');
await a.page.getByText('They match').click();
await c.page.getByText('The Swamp').first().waitFor({ timeout: 30_000 });
await a.page.getByRole('button', { name: 'Done' }).click();
await shot(c.page, '18-linked-device');

// A first tester with no server list: signs up offline, then connects by address.
const d = await launch('newcomer', { noDirectory: true });
await onboard(d.page, 'Dora');
await finishOnboarding(d.page);
await d.page.getByText("Can't reach a coordination server").waitFor({ timeout: 20_000 });
await shot(d.page, '19-no-server');
await d.page.getByLabel('Server address').fill(coordinator.url.replace('http://', ''));
await d.page.getByRole('button', { name: 'Connect' }).click();
await d.page.waitForFunction(() => /Dora#\d+/.test(document.body.innerText), undefined, {
  timeout: 20_000,
});
await d.page.getByText("Can't reach a coordination server").waitFor({ state: 'detached' });
await shot(d.page, '20-connected-by-address');
await d.app.close();

console.log('SMOKE OK');
await a.app.close();
await b.app.close();
await c.app.close();
await coordinator.stop();
await directory.stop();
process.exit(0);
