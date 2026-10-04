/**
 * Stages a realistic space with four people (a conversation and a busy voice
 * room) and screenshots it in both themes, for the website and store
 * listings. Uses the same local directory + coordinator setup as smoke.ts.
 *
 *   xvfb-run -a -s '-screen 0 3000x2000x24' pnpm qa:showcase <outdir>
 *
 * Writes chat-{dark,light}.png and voice-{dark,light}.png at 2x (2560x1600).
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Directory } from '@crocodile/directory';
import { Coordinator } from '@crocodile/coordinator';

const out = process.argv[2] ?? join(tmpdir(), 'croc-showcase');
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
  name: 'Showcase coordinator',
  host: '127.0.0.1',
  port: 0,
  storage: 'memory',
  stunPort: 0,
  directoryUrls: [directory.url],
  announce: true,
  logLevel: 'warn',
}).start();
await new Promise((r) => setTimeout(r, 1000));

type User = { name: string; app: ElectronApplication; page: Page };

const usedColours = new Set<string>();

/** Signs up a new user; retries with a fresh key until their avatar colour is not taken. */
async function launch(name: string): Promise<User> {
  for (let attempt = 0; ; attempt++) {
    const u = await signUp(name);
    const html = await u.page.getByLabel('Account').innerHTML();
    const colour = html.match(/#[0-9a-f]{6}|rgb\([^)]*\)/i)?.[0] ?? '';
    if (!usedColours.has(colour) || attempt >= 15) {
      usedColours.add(colour);
      return u;
    }
    await u.app.close();
  }
}

async function signUp(name: string): Promise<User> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [
      appDir,
      '--no-sandbox',
      '--force-device-scale-factor=2',
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
  // 1280x800 CSS pixels rendered at 2x (the flag above), so the shots stay
  // sharp on high-density screens. setViewportSize would reset the scale.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.setResizable(true);
    w.setContentSize(1280, 800);
  });
  page.on('pageerror', (e) => console.log(`[${name} pageerror] ${e.message}`));
  await page.getByText("I'm new here").click();
  await page.getByPlaceholder('e.g. Wally').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('I saved my recovery key').click();
  await page.getByRole('button', { name: 'Start talking' }).click();
  await page.waitForFunction((n) => new RegExp(`${n}#\\d+`).test(document.body.innerText), name, {
    timeout: 20_000,
  });
  return { name, app, page };
}

async function setTheme(u: User, theme: 'Lagoon' | 'Reed') {
  await u.page.getByLabel('Account').click();
  await u.page.getByText('Settings', { exact: true }).click();
  await u.page.getByRole('button', { name: 'Appearance' }).click();
  await u.page.getByRole('button', { name: theme }).click();
  await u.page.getByRole('button', { name: 'Close settings' }).click();
}

async function addChannel(u: User, kind: 'Text' | 'Voice', name: string) {
  await u.page.getByLabel('Space menu').click();
  await u.page.getByText('New channel or room').click();
  await u.page.getByRole('dialog').getByText(kind, { exact: true }).click();
  await u.page.getByRole('dialog').getByRole('textbox').fill(name);
  await u.page.getByRole('button', { name: 'Create channel' }).click();
  await u.page.getByRole('dialog').waitFor({ state: 'detached' });
}

async function say(u: User, channel: string, text: string, everyone: User[]) {
  await u.page.getByPlaceholder(`Message ${channel}`).fill(text);
  await u.page.keyboard.press('Enter');
  // Wait until everyone has it, so the order is the same on every screen.
  const plain = text.replace(/[*`]/g, '').slice(0, 24);
  for (const o of everyone)
    await o.page.getByText(plain, { exact: false }).first().waitFor({ timeout: 20_000 });
}

async function shot(u: User, name: string) {
  await u.page.mouse.move(1, 1);
  await u.page.waitForTimeout(800);
  await u.page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`screenshot ${name}`);
}

const maya = await launch('Maya');
await maya.page.getByTitle('Create or join a space').click();
await maya.page.getByText('Create my own').click();
await maya.page.getByRole('dialog').getByRole('textbox').fill('Night Owls');
await maya.page.getByRole('button', { name: 'Create' }).click();
await maya.page.getByText('This is the start of general').waitFor({ timeout: 15_000 });
await addChannel(maya, 'Text', 'game-night');
await addChannel(maya, 'Text', 'screenshots');
await addChannel(maya, 'Voice', 'Lounge');

await maya.page.getByRole('button', { name: 'Invite people' }).click();
await maya.page.waitForFunction(() => /croc:\/\/join\/[a-z2-7]+/.test(document.body.innerText));
const invite = await maya.page.evaluate(
  () => document.body.innerText.match(/croc:\/\/join\/[a-z2-7]+/)![0],
);
await maya.page.keyboard.press('Escape');

const others: User[] = [];
for (const name of ['Theo', 'Ines', 'Sam']) {
  const u = await launch(name);
  await u.page.getByTitle('Create or join a space').click();
  await u.page.getByRole('button', { name: 'Join a space' }).click();
  await u.page.getByPlaceholder('croc://join/abcd2345').fill(invite);
  await u.page.getByRole('button', { name: 'Join space' }).click();
  await u.page.getByText('This is the start of general').waitFor({ timeout: 20_000 });
  others.push(u);
}
const [theo, ines, sam] = others as [User, User, User];
const everyone = [maya, theo, ines, sam];
await maya.page.waitForFunction(
  () => /3 peers connected/.test(document.body.innerText),
  undefined,
  {
    timeout: 30_000,
  },
);

for (const u of everyone) await u.page.getByText('game-night', { exact: true }).click();
await say(theo, 'game-night', 'Anyone up for a match tonight? 🎮', everyone);
await say(ines, 'game-night', 'Yes! After 9 though, still finishing work', everyone);
await say(sam, 'game-night', "I'm in. Same squad as last week?", everyone);
await say(maya, 'game-night', 'Same squad 🐊 I made a **Lounge** room for us', everyone);
await say(theo, 'game-night', 'Perfect. Bringing snacks this time', everyone);

await setTheme(maya, 'Lagoon');
await shot(maya, 'chat-dark');
await setTheme(maya, 'Reed');
await shot(maya, 'chat-light');

for (const u of everyone) await u.page.getByRole('button', { name: /^Lounge/ }).click();
await maya.page.waitForFunction(
  () => /you host|hosted by/.test(document.body.innerText),
  undefined,
  {
    timeout: 30_000,
  },
);
await maya.page.waitForFunction(
  () => ['Theo', 'Ines', 'Sam'].every((n) => document.body.innerText.includes(n)),
  undefined,
  { timeout: 30_000 },
);
// A real call: not everyone talks at once.
await ines.page.getByRole('button', { name: 'Mute' }).click();
await sam.page.getByRole('button', { name: 'Mute' }).click();
await maya.page.waitForTimeout(3000);
await shot(maya, 'voice-light');
await setTheme(maya, 'Lagoon');
await shot(maya, 'voice-dark');

console.log('SHOWCASE OK');
for (const u of everyone) await u.app.close();
await coordinator.stop();
await directory.stop();
process.exit(0);
