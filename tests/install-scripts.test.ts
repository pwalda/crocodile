import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The release's Windows installers, in the order the GitHub API lists them.
const WINDOWS_ASSETS = [
  'Crocodile-0.2.0-win-arm64.exe',
  'Crocodile-0.2.0-win-arm64.exe.blockmap',
  'Crocodile-0.2.0-win-x64.exe',
  'Crocodile-0.2.0-win-x64.exe.blockmap',
  'Crocodile-0.2.0-win.exe',
  'Crocodile-0.2.0-win.exe.blockmap',
  'latest.yml',
];

function hasPwsh() {
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Runs scripts/install.ps1 with the network and installer calls replaced, and
// returns the file it downloaded. GitHub's runners have PowerShell, so CI
// always runs these; elsewhere they need pwsh installed.
function installWindows(assets: string[], env: Record<string, string>) {
  const temp = mkdtempSync(join(tmpdir(), 'croc-install-'));
  temps.push(temp);
  const release = JSON.stringify({
    assets: assets.map((name) => ({ name, browser_download_url: `https://example.test/${name}` })),
  });
  const stubs = `
    function Invoke-RestMethod { param($Uri) '${release}' | ConvertFrom-Json }
    function Invoke-WebRequest { param($Uri, $OutFile) Write-Output "downloaded $Uri" }
    function Start-Process { }
    function Write-Host { }
  `;
  const out = execFileSync(
    'pwsh',
    ['-NoProfile', '-Command', `${stubs}; . '${resolve('scripts/install.ps1')}'`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEMP: temp,
        PROCESSOR_ARCHITECTURE: '',
        PROCESSOR_ARCHITEW6432: '',
        ...env,
      },
    },
  );
  return /downloaded https:\/\/example\.test\/(\S+)/.exec(out)?.[1];
}

describe.skipIf(!process.env.CI && !hasPwsh())('install.ps1', () => {
  it('installs the x64 build on an x64 PC', () => {
    expect(installWindows(WINDOWS_ASSETS, { PROCESSOR_ARCHITECTURE: 'AMD64' })).toBe(
      'Crocodile-0.2.0-win-x64.exe',
    );
  });

  it('installs the ARM build on an ARM PC, also from 32-bit PowerShell', () => {
    expect(installWindows(WINDOWS_ASSETS, { PROCESSOR_ARCHITECTURE: 'ARM64' })).toBe(
      'Crocodile-0.2.0-win-arm64.exe',
    );
    expect(
      installWindows(WINDOWS_ASSETS, {
        PROCESSOR_ARCHITECTURE: 'x86',
        PROCESSOR_ARCHITEW6432: 'ARM64',
      }),
    ).toBe('Crocodile-0.2.0-win-arm64.exe');
  });

  it('falls back to the installer with both builds', () => {
    expect(
      installWindows(['Crocodile-0.2.0-win.exe', 'Crocodile-0.2.0-win.exe.blockmap'], {
        PROCESSOR_ARCHITECTURE: 'AMD64',
      }),
    ).toBe('Crocodile-0.2.0-win.exe');
  });
});
