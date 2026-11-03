import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = (name: string) =>
  readFileSync(resolve(__dirname, '../.github/workflows', name), 'utf8');

describe('audit workflow', () => {
  const yml = workflow('audit.yml');

  // The part of the file that says when it runs.
  const triggers = yml.slice(yml.indexOf('\non:\n'), yml.indexOf('\npermissions:'));

  it('audits every dependency, when dependencies change and every week', () => {
    expect(yml).toMatch(/run: pnpm audit --audit-level=high/);
    // (Not `--prod`: the apps list what they bundle as devDependencies.)
    expect(yml).not.toMatch(/pnpm audit [^\n]*--prod/);
    expect(triggers).toMatch(/\n {2}pull_request:\n {4}paths: \[[^\]]*pnpm-lock\.yaml/);
    expect(triggers).toMatch(/\n {2}pull_request:\n {4}paths: \[[^\]]*'\*\*\/package\.json'/);
    expect(triggers).toMatch(/\n {2}schedule:\n {4}- cron: /);
  });

  it('has a read-only token, no stored credentials, and actions pinned to a commit', () => {
    expect(yml).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(yml).not.toMatch(/contents: write|id-token|packages: write/);
    expect(yml).toMatch(/persist-credentials: false/);
    const uses = yml.match(/^\s+- uses: \S+/gm) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});
