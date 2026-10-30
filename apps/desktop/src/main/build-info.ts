import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the build wrote into the app's package.json (see electron-builder.config.cjs). */
export interface BuildInfo {
  /** The macOS build has a Developer ID signature. */
  crocSigned?: unknown;
  /** Made for the end-to-end test: honours the CROC_* test settings. */
  crocTestBuild?: unknown;
}

let info: BuildInfo | undefined;

export function buildInfo(): BuildInfo {
  if (info) return info;
  try {
    info = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as BuildInfo;
  } catch {
    info = {};
  }
  return info;
}
