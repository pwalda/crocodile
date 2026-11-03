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

/** What a fake download holds, so the tests know the checksum the release should list. */
const fakeContent = (name: string) => `fake ${name}`;
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
type Listed = 'good' | 'wrong' | 'missing';
/**
 * The release as the GitHub API lists it: a key to a line, and the digest of an
 * asset before its address.
 */
function releaseJson(
  assets: { name: string; content: string | Uint8Array }[],
  listed: Listed,
  scheme = 'https',
  digest?: string,
) {
  return JSON.stringify(
    {
      assets: assets.map(({ name, content }) => ({
        name,
        ...(listed === 'missing'
          ? {}
          : {
              digest: digest ?? `sha256:${sha256(listed === 'wrong' ? 'something else' : content)}`,
            }),
        browser_download_url: `${scheme}://example.test/${name}`,
      })),
    },
    null,
    2,
  );
}

// Runs scripts/install.ps1 with the network and installer calls replaced. GitHub's
// runners have PowerShell, so CI always runs these; elsewhere they need pwsh installed.
function runWindows(
  assets: string[],
  env: Record<string, string>,
  run: { scheme?: string; listed?: Listed } = {},
) {
  const { scheme = 'https', listed = 'good' } = run;
  const temp = mkdtempSync(join(tmpdir(), 'croc-install-'));
  temps.push(temp);
  const release = releaseJson(
    assets.map((name) => ({ name, content: fakeContent(name) })),
    listed,
    scheme,
  );
  const stubs = `
    function Invoke-RestMethod { param($Uri) '${release}' | ConvertFrom-Json }
    function Invoke-WebRequest {
      param($Uri, $OutFile)
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
        // A checksum that is not listed is found out before anything is downloaded.
        if (listed === 'missing') expect(stdout).not.toContain('downloaded');
        continue;
      }
      throw new Error(`the script ran an installer whose checksum was ${listed}`);
    }
  });

  it('refuses a command line tool that does not match the checksum the release lists', () => {
    const env = { PROCESSOR_ARCHITECTURE: 'AMD64', CROC_INSTALL: 'cli' };
    const assets = ['crocodile-cli-windows-x64.zip'];
    expect(() => runWindows(assets, env, { listed: 'wrong' })).toThrow(/does not match/);
    expect(() => runWindows(assets, env, { listed: 'missing' })).toThrow(/lists no checksum/);
  });

  it('falls back to the installer with both builds', () => {
    expect(
      installWindows(['Crocodile-0.2.0-win.exe', 'Crocodile-0.2.0-win.exe.blockmap'], {
        PROCESSOR_ARCHITECTURE: 'AMD64',
      }),
    ).toBe('Crocodile-0.2.0-win.exe');
  });
});

interface UnixRun {
  /** What the release lists as the checksum of every asset. */
  listed?: Listed;
  /** What the release lists as the checksum of every asset, as it is written (overrides `listed`). */
  digest?: string;
  /** Only the tools the script needs, so what it does is only what the stubs below record. */
  isolated?: boolean;
  /** Programs that only note that they were run (and with what). */
  stubs?: string[];
}

/**
 * Runs scripts/install.sh with `curl` and `uname` replaced: the release lists
 * `assets`, every command line tool is a tarball holding a fake program, and
 * everything else is a file holding its own name.
 */
function installUnix(
  args: string[],
  system: { os: string; arch: string },
  assets: string[],
  run: UnixRun = {},
) {
  const { listed = 'good', isolated = false, stubs = [], digest } = run;
  const temp = mkdtempSync(join(tmpdir(), 'croc-install-sh-'));
  temps.push(temp);
  const bin = join(temp, 'bin');
  const home = join(temp, 'home');
  const fixture = join(temp, 'fixture');
  const program = join(temp, 'program');
  for (const d of [bin, home, fixture, program]) mkdirSync(d);
  const content = (name: string) => {
    if (!name.endsWith('.tar.gz')) return fakeContent(name);
    const tool = name.replace(/\.tar\.gz$/, '');
    writeFileSync(join(program, tool), `#!/bin/sh\necho ${name}\n`);
    chmodSync(join(program, tool), 0o755);
    execFileSync('tar', ['-czf', join(fixture, name), '-C', program, tool]);
    return readFileSync(join(fixture, name));
  };
  writeFileSync(
    join(temp, 'listing'),
    releaseJson(
      assets.map((name) => ({ name, content: content(name) })),
      listed,
      'https',
      digest,
    ) + '\n',
  );
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${join(temp, 'curl.log')}"
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
if [ -z "$out" ]; then cat "${join(temp, 'listing')}"; exit 0; fi
name=$(basename "$url")
if [ -f "${fixture}/$name" ]; then cp "${fixture}/$name" "$out"; else printf 'fake %s' "$name" > "$out"; fi
`,
  );
  writeFileSync(
    join(bin, 'uname'),
    `#!/bin/sh\ncase "$1" in -s) echo ${system.os} ;; -m) echo ${system.arch} ;; esac\n`,
  );
  for (const stub of stubs)
    writeFileSync(
      join(bin, stub),
      `#!/bin/sh\nprintf '%s %s\\n' ${stub} "$*" >> "${join(temp, 'stubs.log')}"\n`,
    );
  for (const f of ['curl', 'uname', ...stubs]) chmodSync(join(bin, f), 0o755);
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
      'mv',
      'chmod',
      'cat',
      'cut',
      'sha256sum',
      'dirname',
    ]) {
      const found = ['/usr/bin', '/bin'].map((d) => join(d, tool)).find((f) => existsSync(f));
      if (found && !existsSync(join(bin, tool))) symlinkSync(found, join(bin, tool));
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
    const log = join(temp, 'curl.log');
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    throw Object.assign(err as Error, { home, calls, ran: ran(temp) });
  }
  const installed = join(home, '.local/bin/crocodile');
  const calls = readFileSync(join(temp, 'curl.log'), 'utf8').trim().split('\n');
  return {
    out,
    calls,
    home,
    ran: ran(temp),
    program: existsSync(installed) ? execFileSync(installed, { encoding: 'utf8' }).trim() : '',
    installed,
  };
}

/** The stub programs that were run, and with what. */
function ran(temp: string) {
  const log = join(temp, 'stubs.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
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

  it('installs the command line tool only when its checksum is the one the release lists', () => {
    const linux = { os: 'Linux', arch: 'x86_64' };
    expect(installUnix(['--cli'], linux, CLI_ASSETS, { listed: 'good' }).program).toBe(
      'crocodile-cli-linux-x64.tar.gz',
    );
    for (const [listed, refused] of [
      ['wrong', /does not match/],
      ['missing', /lists no checksum/],
    ] as const)
      expect(() => installUnix(['--cli'], linux, CLI_ASSETS, { listed })).toThrow(refused);
  });

  it('fetches over https only, redirects included', () => {
    const { calls } = installUnix(['--cli'], { os: 'Linux', arch: 'x86_64' }, CLI_ASSETS);
    // The release list and the program.
    expect(calls).toHaveLength(2);
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
    expect(script.match(/\bfetch -f/g)?.length).toBe(6);
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
  const x64 = { os: 'Linux', arch: 'x86_64' };
  const appImage = (home: string) => join(home, '.local/bin/Crocodile.AppImage');
  const fail = (run: () => unknown) => {
    try {
      run();
    } catch (err) {
      return err as Error & { home: string; calls: string[]; ran: string[] };
    }
    throw new Error('the script did not refuse');
  };

  it('installs an AppImage whose checksum is the one the release lists', () => {
    const run = installUnix([], x64, ['Crocodile-0.2.0-linux-x86_64.AppImage'], {
      isolated: true,
    });
    expect(readFileSync(appImage(run.home), 'utf8')).toBe(
      fakeContent('Crocodile-0.2.0-linux-x86_64.AppImage'),
    );
  });

  it('installs a package only when its checksum is the one the release lists', () => {
    const assets = ['Crocodile-0.2.0-linux-amd64.deb'];
    const stubs = ['sudo'];
    const deb = installUnix([], x64, assets, { isolated: true, stubs: [...stubs, 'apt-get'] });
    expect(deb.ran).toEqual([expect.stringMatching(/^sudo apt-get install -y .*crocodile\.deb$/)]);
    for (const listed of ['wrong', 'missing'] as const)
      expect(
        fail(() =>
          installUnix([], x64, assets, { isolated: true, stubs: [...stubs, 'apt-get'], listed }),
        ).ran,
      ).toEqual([]);
    const rpm = ['Crocodile-0.2.0-linux-x86_64.rpm'];
    const dnf = ['sudo', 'dnf'];
    expect(installUnix([], x64, rpm, { isolated: true, stubs: dnf }).ran).toHaveLength(1);
    expect(
      fail(() => installUnix([], x64, rpm, { isolated: true, stubs: dnf, listed: 'wrong' })).ran,
    ).toEqual([]);
  });

  it('keeps nothing that does not match, and installs nothing that has no checksum listed', () => {
    for (const [listed, refused] of [
      ['wrong', /does not match/],
      ['missing', /lists no checksum/],
    ] as const) {
      const failure = fail(() =>
        installUnix([], x64, ['Crocodile-0.2.0-linux-x86_64.AppImage'], { isolated: true, listed }),
      );
      expect(failure.message).toMatch(refused);
      expect(existsSync(appImage(failure.home))).toBe(false);
      // A checksum that is not listed is found out before the file is downloaded.
      if (listed === 'missing') expect(failure.calls).toHaveLength(1);
    }
  });

  it('refuses a checksum that is not a SHA-256', () => {
    const asset = ['Crocodile-0.2.0-linux-x86_64.AppImage'];
    for (const [digest, refused] of [
      ['sha512:' + 'a'.repeat(128), /lists no checksum/],
      ['sha256:abc', /not a SHA-256/],
      ['sha256:' + 'A'.repeat(64), /not a SHA-256/],
    ] as const)
      expect(fail(() => installUnix([], x64, asset, { isolated: true, digest })).message).toMatch(
        refused,
      );
  });

  // The macOS script removes and replaces /Applications/Crocodile.app where that is writable.
  it.skipIf(process.platform !== 'linux')(
    'opens the macOS app only when its checksum is the one the release lists',
    () => {
      const mac = { os: 'Darwin', arch: 'arm64' };
      const assets = ['Crocodile-0.2.0-mac-universal.zip'];
      const stubs = ['ditto', 'open'];
      expect(installUnix([], mac, assets, { stubs }).ran).toEqual([
        expect.stringMatching(/^ditto -x -k .*croc\.zip /),
        expect.stringMatching(/^open .*Crocodile\.app$/),
      ]);
      for (const listed of ['wrong', 'missing'] as const)
        expect(fail(() => installUnix([], mac, assets, { stubs, listed })).ran).toEqual([]);
    },
  );
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

  it('keeps no credentials in the checkouts and no cache in the jobs', () => {
    const text = yml();
    const checkouts = text.match(/uses: actions\/checkout@/g)?.length ?? 0;
    expect(checkouts).toBeGreaterThan(0);
    expect(text.match(/persist-credentials: false/g)?.length).toBe(checkouts);
    expect(text).not.toMatch(/^\s+cache:/m);
  });
});
