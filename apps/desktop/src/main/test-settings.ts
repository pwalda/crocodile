import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { honoursTestSettings } from './trust';

function buildInfo(): { crocTestBuild?: unknown } {
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

const honoured = honoursTestSettings(app.isPackaged, buildInfo());

/** An environment variable for tests and development: unset in a release. */
export function testSetting(name: string): string | undefined {
  return honoured ? process.env[name] : undefined;
}
