// Builds the Electron app: esbuild for main/preload/utility processes, Vite for the UI.
import { build, context } from 'esbuild';
import { createServer, build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { cpSync, rmSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const define = {
  'process.env.CROC_DIRECTORIES': JSON.stringify(process.env.CROC_DIRECTORIES ?? ''),
  'process.env.CROC_APP_VERSION': JSON.stringify(process.env.npm_package_version ?? '0.1.0'),
};

const nodeTargets = [
  { entry: 'src/main/main.ts', out: 'dist/main/main.cjs' },
  { entry: 'src/main/relay-process.ts', out: 'dist/main/relay-process.cjs' },
  { entry: 'src/main/coordinator-process.ts', out: 'dist/main/coordinator-process.cjs' },
  { entry: 'src/preload/preload.ts', out: 'dist/preload/preload.cjs' },
];

/**
 * Native modules are copied (not bundled) into dist/native and unpacked from
 * the asar at runtime: libuiohook for system-wide push-to-talk.
 */
function copyNative() {
  const require = createRequire(join(root, 'package.json'));
  const out = join(root, 'dist/native');
  rmSync(out, { recursive: true, force: true });
  const uiohook = dirname(require.resolve('uiohook-napi/package.json'));
  const gypBuild = dirname(
    createRequire(join(uiohook, 'package.json')).resolve('node-gyp-build/package.json'),
  );
  for (const [src, dst] of [
    [join(uiohook, 'dist'), 'uiohook-napi/dist'],
    [join(uiohook, 'prebuilds'), 'uiohook-napi/prebuilds'],
    [join(uiohook, 'package.json'), 'uiohook-napi/package.json'],
    [gypBuild, 'node_modules/node-gyp-build'],
  ]) {
    cpSync(src, join(out, dst), { recursive: true, dereference: true });
  }
}

const nodeOptions = (t) => ({
  absWorkingDir: root,
  entryPoints: [t.entry],
  outfile: t.out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  define,
  logLevel: 'info',
});

copyNative();

if (dev) {
  for (const t of nodeTargets) (await context(nodeOptions(t))).watch();
  const server = await createServer({ configFile: join(root, 'vite.config.ts'), define });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const require = createRequire(import.meta.url);
  const electron = require('electron');
  const args = ['.', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])];
  const child = spawn(electron, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CROC_RENDERER_URL: url },
  });
  child.on('exit', (code) => {
    void server.close();
    process.exit(code ?? 0);
  });
} else {
  await Promise.all(nodeTargets.map((t) => build(nodeOptions(t))));
  await viteBuild({ configFile: join(root, 'vite.config.ts'), define });
}
