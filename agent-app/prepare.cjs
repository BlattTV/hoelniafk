/**
 * Prepares agent-app/runtime for packaging: builds the suite (the agent is part of it),
 * copies dist + package files, installs production dependencies and bundles Node.
 *
 *   cd agent-app && npm install && npm run dist      (on Windows → release/Hoelni-Agent-Setup-*.exe)
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const out = path.join(__dirname, 'runtime');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

console.log('› building');
run(npm, ['run', 'build'], repo);

console.log('› copying runtime files');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const item of ['dist', 'package.json', 'package-lock.json']) fs.cpSync(path.join(repo, item), path.join(out, item), { recursive: true });

console.log('› installing production dependencies');
run(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], out);

console.log(`› bundling Node ${process.version}`);
fs.mkdirSync(path.join(out, 'node', 'bin'), { recursive: true });
fs.copyFileSync(process.execPath, process.platform === 'win32' ? path.join(out, 'node', 'node.exe') : path.join(out, 'node', 'bin', 'node'));
console.log('✓ agent-app/runtime ready');
