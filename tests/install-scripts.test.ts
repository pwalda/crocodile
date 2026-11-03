import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
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

/** What the fake downloads hold, so the tests know the hash the release should list. */
const fakeContent = (name: string) => `fake ${name}`;
const sha512 = (text: string | Uint8Array) => createHash('sha512').update(text).digest('base64');
type Listed = 'good' | 'wrong' | 'missing';
const isInstaller = (n: string) => !/\.(blockmap|ya?ml|sha512)$/.test(n);
/** An update file (latest*.yml) listing each installer's SHA-512, as electron-builder writes it. */
function updateFile(assets: string[], listed: Listed) {
  const files = assets.filter(isInstaller);
  return [
    'version: 0.2.0',
    'files:',
    ...(listed === 'missing'
      ? []
      : files.flatMap((n) => [
          `  - url: ${n}`,
          `    sha512: ${sha512(listed === 'wrong' ? 'something else' : fakeContent(n))}`,
          '    size: 1',
        ])),
    `path: ${files[0] ?? ''}`,
    '',
  ].join('\n');
}

// Runs scripts/install.ps1 with the network and installer calls replaced, and
// returns the file it downloaded. GitHub's runners have PowerShell, so CI
// always runs these; elsewhere they need pwsh installed.
interface WindowsRun {
  scheme?: string;
  /** What the release's update file says about the installer. */
  listed?: Listed;
  /** The command line tool's checksum file: absent, right or wrong. */
  sidecar?: 'none' | 'good' | 'wrong';
}

function runWindows(assets: string[], env: Record<string, string>, run: WindowsRun = {}) {
  const { scheme = 'https', listed = 'good', sidecar = 'none' } = run;
  const temp = mkdtempSync(join(tmpdir(), 'croc-install-'));
  temps.push(temp);
  const release = JSON.stringify({
    assets: assets.map((name) => ({
      name,
      browser_download_url: `${scheme}://example.test/${name}`,
    })),
  });
  const cli = assets.find((n) => n.startsWith('crocodile-cli-')) ?? '';
  const stubs = `
    function Invoke-RestMethod { param($Uri) '${release}' | ConvertFrom-Json }
    function Invoke-WebRequest {
      param($Uri, $OutFile)
      if ($Uri -like '*.yml') { return [pscustomobject]@{ Content = $env:CROC_TEST_YML } }
      if ($Uri -like '*.sha512') {
        if ($env:CROC_TEST_SIDECAR) { return [pscustomobject]@{ Content = $env:CROC_TEST_SIDECAR } }
        throw 'Not Found'
      }
      [Console]::Out.WriteLine("downloaded $Uri")
      $name = ($Uri -split '/')[-1]
      [IO.File]::WriteAllBytes($OutFile, [Text.Encoding]::UTF8.GetBytes("${fakeContent('')}$name"))
      # Where the download ended up, after any redirect (-PassThru gives the response).
      if ($env:CROC_TEST_FINAL_URL) {
        [pscustomobject]@{ BaseResponse = [pscustomobject]@{ ResponseUri = [uri]$env:CROC_TEST_FINAL_URL } }
      }
    }
    function Start-Process { [Console]::Out.WriteLine('started') }
    function Write-Host { }
  `;
  return execFileSync(
    'pwsh',
    ['-NoProfile', '-Command', `${stubs}; . '${resolve('scripts/install.ps1')}'`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEMP: temp,
        PROCESSOR_ARCHITECTURE: '',
        PROCESSOR_ARCHITEW6432: '',
        CROC_TEST_YML: updateFile(assets, listed),
        CROC_TEST_SIDECAR:
          sidecar === 'none'
            ? ''
            : sha512(sidecar === 'good' ? fakeContent(cli) : 'something else'),
        ...env,
      },
    },
  );
}

// The file it downloaded.
function installWindows(assets: string[], env: Record<string, string>, scheme = 'https') {
  const out = runWindows(assets, env, { scheme });
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

  it('does not download from an address that is not https', () => {
    const refused = /not https/;
    for (const scheme of ['http', 'ftp']) {
      expect(() =>
        installWindows(WINDOWS_ASSETS, { PROCESSOR_ARCHITECTURE: 'AMD64' }, scheme),
      ).toThrow(refused);
      expect(() =>
        installWindows(
          ['crocodile-cli-windows-x64.zip'],
          { PROCESSOR_ARCHITECTURE: 'AMD64', CROC_INSTALL: 'cli' },
          scheme,
        ),
      ).toThrow(refused);
    }
  });

  it('refuses before downloading anything, not after', () => {
    try {
      installWindows(WINDOWS_ASSETS, { PROCESSOR_ARCHITECTURE: 'AMD64' }, 'http');
    } catch (err) {
      expect(String((err as { stdout?: string }).stdout)).not.toContain('downloaded');
      return;
    }
    throw new Error('the script did not refuse');
  });

  it('does not run, nor keep, a download that a redirect took away from https', () => {
    const refused = /not https/;
    const env = {
      PROCESSOR_ARCHITECTURE: 'AMD64',
      CROC_TEST_FINAL_URL: 'http://example.test/Crocodile-0.2.0-win-x64.exe',
    };
    expect(() => installWindows(WINDOWS_ASSETS, env)).toThrow(refused);
    expect(() =>
      installWindows(['crocodile-cli-windows-x64.zip'], { ...env, CROC_INSTALL: 'cli' }),
    ).toThrow(refused);
  });

  it('runs the installer only when its checksum is the one the release lists', () => {
    const env = { PROCESSOR_ARCHITECTURE: 'AMD64' };
    expect(runWindows(WINDOWS_ASSETS, env)).toContain('started');
    for (const [listed, refused] of [
      ['wrong', /does not match/],
      ['missing', /lists no checksum/],
    ] as const) {
      try {
        runWindows(WINDOWS_ASSETS, env, { listed });
      } catch (err) {
        const { stdout, message } = err as { stdout: string; message: string };
        expect(message).toMatch(refused);
        expect(stdout).not.toContain('started');
        continue;
      }
      throw new Error(`the script ran an installer whose checksum was ${listed}`);
    }
  });

  it('refuses a command line tool that does not match the checksum published with it', () => {
    const env = { PROCESSOR_ARCHITECTURE: 'AMD64', CROC_INSTALL: 'cli' };
    expect(() => runWindows(['crocodile-cli-windows-x64.zip'], env, { sidecar: 'wrong' })).toThrow(
      /does not match/,
    );
  });

  it('falls back to the installer with both builds', () => {
    expect(
      installWindows(['Crocodile-0.2.0-win.exe', 'Crocodile-0.2.0-win.exe.blockmap'], {
        PROCESSOR_ARCHITECTURE: 'AMD64',
      }),
    ).toBe('Crocodile-0.2.0-win.exe');
  });
});

/**
 * Runs scripts/install.sh with `curl` and `uname` replaced: the release lists
 * `assets`, every command line tool is a tarball holding a fake program, and
 * everything else is a file holding its own name.
 */
interface UnixRun {
  /** What the release's update file says about the installer. */
  listed?: Listed;
  /** The command line tool's checksum file: absent, right or wrong. */
  sidecar?: 'none' | 'good' | 'wrong';
  /** Only the tools the script needs: no apt-get, dnf or zypper, so a Linux app goes in as an AppImage. */
  isolated?: boolean;
}

function installUnix(
  args: string[],
  system: { os: string; arch: string },
  assets: string[],
  run: UnixRun = {},
) {
  const { listed = 'good', sidecar = 'none', isolated = false } = run;
  const temp = mkdtempSync(join(tmpdir(), 'croc-install-sh-'));
  temps.push(temp);
  const bin = join(temp, 'bin');
  const home = join(temp, 'home');
  const fixture = join(temp, 'fixture');
  const program = join(temp, 'program');
  for (const d of [bin, home, fixture, program]) mkdirSync(d);
  for (const a of assets.filter((n) => n.endsWith('.tar.gz'))) {
    const name = a.replace(/\.tar\.gz$/, '');
    writeFileSync(join(program, name), `#!/bin/sh\necho ${a}\n`);
    chmodSync(join(program, name), 0o755);
    execFileSync('tar', ['-czf', join(fixture, a), '-C', program, name]);
  }
  // The program the script picks for this system.
  const cli = `crocodile-cli-${system.os === 'Darwin' ? 'macos' : 'linux'}-${
    /^(x86_64|amd64)$/.test(system.arch) ? 'x64' : 'arm64'
  }.tar.gz`;
  if (sidecar !== 'none' && existsSync(join(fixture, cli)))
    writeFileSync(
      join(temp, 'sidecar'),
      sidecar === 'good' ? sha512(readFileSync(join(fixture, cli))) : sha512('something else'),
    );
  writeFileSync(join(temp, 'update.yml'), updateFile(assets, listed));
  writeFileSync(
    join(temp, 'listing'),
    assets.map((n) => `"browser_download_url": "https://example.test/${n}"`).join('\n') + '\n',
  );
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${join(temp, 'curl.log')}"
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
case "$url" in
  https://api.github.com/*) cat "${join(temp, 'listing')}" ;;
  *.yml) cat "${join(temp, 'update.yml')}" ;;
  *.sha512) if [ -f "${join(temp, 'sidecar')}" ]; then cat "${join(temp, 'sidecar')}"; else exit 22; fi ;;
  *)
    name=$(basename "$url")
    if [ -f "${fixture}/$name" ]; then cp "${fixture}/$name" "$out"; else printf 'fake %s' "$name" > "$out"; fi ;;
esac
`,
  );
  writeFileSync(
    join(bin, 'uname'),
    `#!/bin/sh\ncase "$1" in -s) echo ${system.os} ;; -m) echo ${system.arch} ;; esac\n`,
  );
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'uname'), 0o755);
  if (isolated) {
    for (const tool of [
      'sh',
      'tar',
      'gzip',
      'mktemp',
      'basename',
      'grep',
      'sed',
      'head',
      'awk',
      'rm',
      'mkdir',
      'cp',
      'chmod',
      'cat',
      'od',
      'base64',
      'tr',
      'cut',
      'sha512sum',
      'dirname',
    ]) {
      const found = ['/usr/bin', '/bin'].map((d) => join(d, tool)).find((f) => existsSync(f));
      if (found) symlinkSync(found, join(bin, tool));
    }
  }
  let out: string;
  try {
    out = execFileSync('sh', [resolve('scripts/install.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: isolated ? bin : `${bin}:/usr/bin:/bin`, HOME: home },
    });
  } catch (err) {
    // So a test can look at what the script left behind.
    throw Object.assign(err as Error, { home });
  }
  const installed = join(home, '.local/bin/crocodile');
  const calls = readFileSync(join(temp, 'curl.log'), 'utf8').trim().split('\n');
  return {
    out,
    calls,
    home,
    program: existsSync(installed) ? execFileSync(installed, { encoding: 'utf8' }).trim() : '',
    installed,
  };
}

const CLI_ASSETS = [
  'Crocodile-0.7.0-linux-x86_64.AppImage',
  'crocodile-cli-linux-arm64.tar.gz',
  'crocodile-cli-linux-x64.tar.gz',
  'crocodile-cli-macos-arm64.tar.gz',
  'crocodile-cli-windows-x64.zip',
];

describe.skipIf(process.platform === 'win32')('install.sh --cli', () => {
  it('installs the command line tool for this system and processor', () => {
    const linux = installUnix(['--cli'], { os: 'Linux', arch: 'x86_64' }, CLI_ASSETS);
    expect(linux.program).toBe('crocodile-cli-linux-x64.tar.gz');
    expect(linux.out).toMatch(/Add ~\/.local\/bin to your PATH/);
    const arm = installUnix(['--cli'], { os: 'Linux', arch: 'aarch64' }, CLI_ASSETS);
    expect(arm.program).toBe('crocodile-cli-linux-arm64.tar.gz');
    const mac = installUnix(['--cli'], { os: 'Darwin', arch: 'arm64' }, CLI_ASSETS);
    expect(mac.program).toBe('crocodile-cli-macos-arm64.tar.gz');
    expect(readFileSync(mac.installed, 'utf8')).toMatch(/^#!\/bin\/sh/);
  });

  it('checks the command line tool against the checksum published with it', () => {
    const linux = { os: 'Linux', arch: 'x86_64' };
    const good = installUnix(['--cli'], linux, CLI_ASSETS, { sidecar: 'good' });
    expect(good.program).toBe('crocodile-cli-linux-x64.tar.gz');
    expect(good.calls.at(-1)).toMatch(/crocodile-cli-linux-x64\.tar\.gz\.sha512$/);
    expect(() => installUnix(['--cli'], linux, CLI_ASSETS, { sidecar: 'wrong' })).toThrow(
      /does not match/,
    );
  });

  it('installs a command line tool that has no checksum published, and says so', () => {
    const { out, program } = installUnix(['--cli'], { os: 'Linux', arch: 'x86_64' }, CLI_ASSETS);
    expect(program).toBe('crocodile-cli-linux-x64.tar.gz');
    expect(out).toMatch(/No checksum is published/);
  });

  it('fetches over https only, redirects included', () => {
    const { calls } = installUnix(['--cli'], { os: 'Linux', arch: 'x86_64' }, CLI_ASSETS);
    // The release list, the program and its checksum (there is none published here).
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call).toMatch(/^--proto =https --proto-redir =https /);
  });

  it('has no download that skips that', () => {
    // The run above takes one path; the others (the app for each system) are read here.
    const script = readFileSync(resolve('scripts/install.sh'), 'utf8');
    const downloads = script.split('\n').filter((l) => /\bcurl\b/.test(l) && !/^\s*#/.test(l));
    expect(downloads.map((l) => l.trim())).toEqual([
      "fetch() { curl --proto '=https' --proto-redir '=https' \"$@\"; }",
      'need curl',
    ]);
    // The release list, the app for each system (and each package), the CLI, and the checks.
    expect(script.match(/\bfetch -f/g)?.length).toBe(8);
  });

  it('points to npm when there is no build for the processor', () => {
    expect(() => installUnix(['--cli'], { os: 'Darwin', arch: 'x86_64' }, CLI_ASSETS)).toThrow(
      /npm install -g crocodile-cli/,
    );
    // Never taken for ARM: a program that can't run there.
    for (const arch of ['i686', 'riscv64', 'armv7l'])
      expect(() => installUnix(['--cli'], { os: 'Linux', arch }, CLI_ASSETS)).toThrow(
        /unsupported CPU architecture/,
      );
  });
});

describe.skipIf(process.platform === 'win32')('install.sh, the app', () => {
  const ASSETS = [
    'Crocodile-0.2.0-linux-arm64.AppImage',
    'Crocodile-0.2.0-linux-x86_64.AppImage',
    'latest-linux.yml',
  ];
  const linux = { os: 'Linux', arch: 'x86_64' };
  const appImage = (home: string) => join(home, '.local/bin/Crocodile.AppImage');

  it('installs what the release lists a checksum for, from the update file of its system', () => {
    const run = installUnix([], linux, ASSETS, { isolated: true });
    expect(readFileSync(appImage(run.home), 'utf8')).toBe(
      fakeContent('Crocodile-0.2.0-linux-x86_64.AppImage'),
    );
    expect(run.calls.some((c) => /\/latest-linux\.yml$/.test(c))).toBe(true);
    const arm = installUnix([], { os: 'Linux', arch: 'aarch64' }, ASSETS, { isolated: true });
    expect(arm.calls.some((c) => /\/latest-linux-arm64\.yml$/.test(c))).toBe(true);
  });

  it('keeps nothing that does not match the checksum the release lists', () => {
    for (const [listed, refused] of [
      ['wrong', /does not match/],
      ['missing', /lists no checksum/],
    ] as const) {
      let failure: (Error & { home?: string }) | undefined;
      try {
        installUnix([], linux, ASSETS, { isolated: true, listed });
      } catch (err) {
        failure = err as Error & { home?: string };
      }
      expect(failure?.message).toMatch(refused);
      expect(existsSync(appImage(failure!.home!))).toBe(false);
    }
  });
});

describe('release workflow', () => {
  it('publishes a release only once every program the installers fetch is in it', () => {
    const yml = readFileSync(resolve(__dirname, '../.github/workflows/release.yml'), 'utf8');
    const needs = /\n {2}publish:\n(?: {4}.*\n)*? {4}needs: \[([^\]]*)\]/.exec(yml)?.[1];
    expect(needs?.split(',').map((s) => s.trim())).toEqual(
      expect.arrayContaining(['installers', 'cli']),
    );
  });

  const yml = () => readFileSync(resolve(__dirname, '../.github/workflows/release.yml'), 'utf8');

  it('gives a platform only its own signing secrets', () => {
    const lines = yml().split('\n');
    const secrets = lines.filter((l) => /secrets\.(CSC_|APPLE_|AZURE_)/.test(l));
    expect(secrets.map((l) => l.trim().split(':')[0])).toEqual(
      expect.arrayContaining(['CSC_LINK', 'APPLE_TEAM_ID', 'AZURE_CLIENT_SECRET']),
    );
    // A platform that is not given a secret gets an empty value, which the step unsets.
    const unset = lines.find((l) => l.includes('for v in '));
    for (const line of secrets) {
      expect(unset, line).toMatch(new RegExp(`\\b${line.trim().split(':')[0]}\\b`));
      const os = /secrets\.AZURE_/.test(line) ? 'Windows' : 'macOS';
      expect(line, line).toContain(`\${{ runner.os == '${os}' && secrets.`);
    }
  });

  it('publishes a checksum next to each command line program', () => {
    expect(yml()).toContain('gh release upload "$TAG" "$asset" "$asset.sha512" --clobber');
  });

  it('keeps no credentials in the checkouts and no cache in the jobs', () => {
    const text = yml();
    const checkouts = text.match(/uses: actions\/checkout@/g)?.length ?? 0;
    expect(checkouts).toBeGreaterThan(0);
    expect(text.match(/persist-credentials: false/g)?.length).toBe(checkouts);
    expect(text).not.toMatch(/^\s+cache:/m);
  });
});
