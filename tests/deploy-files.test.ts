import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const compose = readFileSync(resolve(__dirname, '../docker-compose.yml'), 'utf8');
/** The lines of one service of the compose file. */
const service = (name: string) =>
  new RegExp(`\\n {2}${name}:\\n((?: {4}.*\\n|\\n)*)`).exec(compose)?.[1] ?? '';

describe('docker-compose.yml', () => {
  it('passes the coordinator the settings a public server needs', () => {
    const coordinator = service('coordinator');
    for (const name of ['CROC_HOST', 'CROC_RELAY_IP', 'CROC_CONTACT', 'CROC_TRUST_PROXY'])
      expect(coordinator, name).toMatch(new RegExp(`\\n {6}${name}: \\$\\{${name}:-`));
    // Not behind a proxy unless said so: it would believe any client's X-Forwarded-For.
    expect(coordinator).toMatch(/CROC_TRUST_PROXY: \$\{CROC_TRUST_PROXY:-\}/);
  });

  it('keeps the directory on the machine unless told otherwise', () => {
    const directory = service('directory');
    expect(directory).toContain("- '${CROC_DIR_BIND:-127.0.0.1}:7400:7400'");
    expect(directory).toMatch(/CROC_DIR_TRUST_PROXY: \$\{CROC_DIR_TRUST_PROXY:-\}/);
  });
});
