import { isAllowedNavigation } from './navigation';

/**
 * Who may use what the main process offers. The UI's preload hands out the
 * identity seed, the local data key and the file store over IPC, so a page
 * other than the app's own (a file dragged in, a frame inside the app) must
 * not be able to ask, however it got there.
 */

/** Where the app's own page lives, and the dev server's origin when one is used. */
export interface Pages {
  appUrl: string;
  devUrl?: string | undefined;
}

/** A frame showing the app's own page. A missing URL (a frame already gone) is nobody. */
export function isAppPage(url: string | undefined | null, pages: Pages): boolean {
  return !!url && isAllowedNavigation(url, pages.appUrl, pages.devUrl);
}

/** What Electron tells a handler about whoever is asking. */
export interface Asker {
  /** The contents that sent it; only the app's own window is served. */
  fromWindow: boolean;
  /** The URL of the frame that sent it. */
  url: string | undefined | null;
  /** The page itself, not a frame inside it. */
  topFrame: boolean;
}

export function mayAsk(asker: Asker, pages: Pages): boolean {
  return asker.fromWindow && asker.topFrame && isAppPage(asker.url, pages);
}

/**
 * The environment variables that point the app at a test server, another
 * profile or a pretend update. A release honours none of them (local
 * software could otherwise start it with the app's permissions and its
 * keychain entry on a profile of its choosing); a development run honours
 * them, and so does a build made for the end-to-end test.
 */
export function honoursTestSettings(packaged: boolean, meta: { crocTestBuild?: unknown }): boolean {
  return !packaged || meta.crocTestBuild === true;
}

/**
 * Chromium and Node switches that open the running app to another program
 * (a debugging port or pipe, an inspector). The fuses turn off Node's; these
 * Chromium's are refused at start. Chromium takes `--x`, `-x` and, on
 * Windows, `/x`. Returns the first one found.
 */
export function openingSwitch(
  argv: readonly string[],
  platform = process.platform,
): string | undefined {
  const lead = platform === 'win32' ? '(?:--?|/)' : '--?';
  const re = new RegExp(`^${lead}(?:remote-debugging-|remote-allow-origins|inspect|debug)`, 'i');
  return argv.find((a) => re.test(a));
}

/**
 * The environment for the script that swaps in an update: a fixed path and
 * the few things the system tools need, nothing else from the app's own
 * environment. A relaunch command is passed on only where test settings are.
 */
export function scriptEnvironment(env: NodeJS.ProcessEnv, honoured: boolean): NodeJS.ProcessEnv {
  const fixed: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const name of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'])
    if (env[name] !== undefined) fixed[name] = env[name];
  if (honoured && env.CROC_RELAUNCH !== undefined) fixed.CROC_RELAUNCH = env.CROC_RELAUNCH;
  return fixed;
}
