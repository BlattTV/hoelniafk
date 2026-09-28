/**
 * Prepares desktop/bundle/backend for packaging (→ resources/backend in the installed program): builds the suite, copies the runtime files,
 * installs production dependencies and bundles the Node binary that installed them
 * (the suite has no native add-ons of its own; Node 22.13+ provides SQLite built in).
 *
 *   cd desktop && npm install && npm run dist      (on Windows → release/*.exe)
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
// electron-builder drops a node_modules folder at the ROOT of an extraResources source, so the
// runtime lives one level deeper (bundle/backend/node_modules is copied).
fs.rmSync(path.join(__dirname, 'backend'), { recursive: true, force: true }); // layout of older versions
const out = path.join(__dirname, 'bundle', 'backend');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

console.log('› building the suite');
run(npm, ['run', 'build'], repo);

console.log('› copying runtime files');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const item of ['dist', 'public', 'config', 'package.json', 'package-lock.json']) {
  fs.cpSync(path.join(repo, item), path.join(out, item), { recursive: true, filter: (src) => !/app\.yaml$/.test(src) || src.endsWith('app.example.yaml') });
}

console.log('› installing production dependencies');
run(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], out);

console.log(`› bundling Node ${process.version}`);
const nodeDir = path.join(out, 'node');
fs.mkdirSync(path.join(nodeDir, 'bin'), { recursive: true });
fs.copyFileSync(process.execPath, process.platform === 'win32' ? path.join(nodeDir, 'node.exe') : path.join(nodeDir, 'bin', 'node'));
// npm next to it: the in-app updater reinstalls dependencies when package-lock.json changes
const npmSrc = [path.join(path.dirname(process.execPath), 'node_modules', 'npm'), path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm')].find((p) => fs.existsSync(p));
if (npmSrc) fs.cpSync(npmSrc, path.join(nodeDir, 'node_modules', 'npm'), { recursive: true });
else console.warn('! npm not found next to node – dependency updates will need a new installer');
if (!fs.existsSync(path.join(out, 'node_modules', 'yaml'))) throw new Error('node_modules missing after npm ci');
console.log('✓ desktop/bundle/backend ready');
