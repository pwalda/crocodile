// Renders build/icon.svg to PNGs with Chromium (no native image tooling needed).
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const appDir = join(import.meta.dirname, '../../apps/desktop');
const svg = readFileSync(join(appDir, 'build/icon.svg'), 'utf8');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
});
for (const [size, out] of [
  [1024, 'build/icon.png'],
  [512, 'resources/icon.png'],
  [32, 'resources/tray.png'],
] as const) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</body></html>`,
  );
  await page.screenshot({ path: join(appDir, out), omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icons rendered');
