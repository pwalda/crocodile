import { app } from 'electron';
import { buildInfo } from './build-info';
import { honoursTestSettings } from './trust';

export const testSettingsOn = honoursTestSettings(app.isPackaged, buildInfo());

/** An environment variable for tests and development: unset in a release. */
export function testSetting(name: string): string | undefined {
  return testSettingsOn ? process.env[name] : undefined;
}
