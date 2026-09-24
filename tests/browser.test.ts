import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import type { Server } from 'node:http';
import type { Coordinator } from '@crocodile/coordinator';
import { attachRelayBridge, launchBrowser, relayFrames, serveHarness } from './browser/harness';
import { startCoordinator, waitFor } from './helpers';

/**
 * Real-browser end-to-end test: Chromium clients, real WebRTC to a real
 * werift host relay, E2EE voice frames through the encoded-transform worker.
 */
let browser: Browser;
let harness: { url: string; server: Server };
let coord: Coordinator;

beforeAll(async () => {
  coord = await startCoordinator({ stunPort: 0 });
  harness = await serveHarness();
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  harness?.server.close();
  await coord?.stop();
});

async function openClient(name: string, canHost: boolean, nat = 'cone'): Promise<{ page: Page; userId: string }> {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (process.env.DBG) console.log(`[${name} console] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await attachRelayBridge(page, () => coord.stunUrls().map((urls) => ({ urls })), !!process.env.DBG);
  await page.goto(harness.url);
  const userId = await page.evaluate(
    ([server, n, h, nt]) => window.startClient({ server: server as string, name: n as string, canHost: h as boolean, nat: nt as string }),
    [coord.url, name, canHost, nat] as const,
  );
  return { page, userId };
}

async function until(page: Page, fn: string, timeoutMs = 15_000) {
  await page.waitForFunction(fn, undefined, { timeout: timeoutMs, polling: 100 });
}

describe('browser end-to-end', () => {
  it('voice and text flow through the elected host relay, end-to-end encrypted', async () => {
    const alice = await openClient('alice', true, 'open');
    const bob = await openClient('bob', true, 'cone');
    const carol = await openClient('carol', false);

    const spaceId = await alice.page.evaluate(() => window.croc.createSpace('Browser Swamp'));
    const code = await alice.page.evaluate((s) => window.croc.createInvite(s), spaceId);
    await bob.page.evaluate((c) => window.croc.joinWithInvite(c), code);
    await carol.page.evaluate((c) => window.croc.joinWithInvite(c), code);

    const voiceChannel = await alice.page.evaluate(
      (s) => window.croc.state.spaces[s]!.channels.find((c) => c.kind === 'voice')!.id,
      spaceId,
    );
    const voiceSession = `voice:${spaceId}:${voiceChannel}`;
    for (const c of [alice, bob, carol]) {
      await c.page.evaluate(([s, ch]) => window.croc.joinVoice(s as string, ch as string), [spaceId, voiceChannel] as const);
    }
    for (const c of [alice, bob, carol]) {
      await until(c.page, `window.croc.state.sessions['${voiceSession}']?.status === 'connected' && window.croc.state.sessions['${voiceSession}'].peers.length === 2`, 25_000);
    }
    const view = await carol.page.evaluate((s) => window.croc.state.sessions[s], voiceSession);
    expect(view!.host).toBe(alice.userId);
    expect(view!.backup).toBe(bob.userId);

    // Everyone's fake microphone emits a tone; listeners must decode real
    // audio, which only happens if frame decryption succeeded.
    for (const c of [bob, carol]) {
      const stats = await waitForAudio(c.page);
      expect(stats.energy).toBeGreaterThan(0.001);
    }
    // The relay only ever saw ciphertext.
    expect(relayFrames.total).toBeGreaterThan(100);
    expect(relayFrames.encrypted).toBe(relayFrames.total);

    // Text over the space's data-channel mesh.
    const textChannel = await alice.page.evaluate(
      (s) => window.croc.state.spaces[s]!.channels.find((c) => c.kind === 'text')!.id,
      spaceId,
    );
    await carol.page.evaluate((ch) => window.croc.openChannel(ch), textChannel);
    await until(carol.page, `window.croc.state.sessions['space:${spaceId}']?.peers.length === 2`, 20_000);
    await alice.page.evaluate((ch) => window.croc.sendMessage(ch, 'hello from a real browser'), textChannel);
    await until(carol.page, `(window.croc.state.messages['${textChannel}'] ?? []).some(m => m.body === 'hello from a real browser')`);

    // Host leaves: the backup takes over and voice resumes.
    await alice.page.evaluate(() => window.croc.shutdown());
    await until(carol.page, `window.croc.state.sessions['${voiceSession}']?.host === '${bob.userId}' && window.croc.state.sessions['${voiceSession}']?.status === 'connected' && window.croc.state.sessions['${voiceSession}'].peers.length === 1`, 30_000);
    const after = await waitForAudio(carol.page);
    expect(after.energy).toBeGreaterThan(0.001);
  }, 120_000);
});

async function waitForAudio(page: Page) {
  const deadline = Date.now() + 20_000;
  let best = { packets: 0, energy: 0, concealed: 0, samples: 0 };
  let baseline: number | null = null;
  while (Date.now() < deadline) {
    const all = await page.evaluate(() => window.audioStats());
    const energy = all.reduce((n, s) => n + s.energy, 0);
    if (baseline === null) baseline = energy;
    best = { packets: all.reduce((n, s) => n + s.packets, 0), energy: energy - baseline, concealed: 0, samples: 0 };
    if (best.energy > 0.001) return best;
    await new Promise((r) => setTimeout(r, 250));
  }
  return best;
}
