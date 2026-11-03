import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = (name: string) =>
  readFileSync(resolve(__dirname, '../.github/workflows', name), 'utf8');

describe('audit workflow', () => {
  const yml = workflow('audit.yml');

  it('audits what ships, when the lockfile changes and every week', () => {
    expect(yml).toMatch(/run: pnpm audit --prod --audit-level=high/);
    expect(yml).toMatch(/paths: \[pnpm-lock\.yaml/);
    expect(yml).toMatch(/schedule:\n\s+- cron: /);
  });

  it('has a read-only token, no stored credentials, and actions pinned to a commit', () => {
    expect(yml).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(yml).not.toMatch(/contents: write|id-token|packages: write/);
    expect(yml).toMatch(/persist-credentials: false/);
    const uses = yml.match(/uses: \S+/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});
