import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { supervise } from '../src/supervisor.js';
import { waitFor } from './helpers.js';

describe('process supervisor', () => {
  it('restarts a crashing child with backoff and stops cleanly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-sup-'));
    const counter = path.join(dir, 'count');
    const script = path.join(dir, 'child.cjs');
    // crashes twice, then stays up until SIGTERM
    fs.writeFileSync(
      script,
      `const fs=require('fs');const f=${JSON.stringify(counter)};const n=(fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0)+1;fs.writeFileSync(f,String(n));
       if(n<3){process.exit(1)}
       process.on('SIGTERM',()=>{fs.writeFileSync(f+'.term','1');process.exit(0)});setInterval(()=>{},1000);`,
    );
    const logs: string[] = [];
    const sup = supervise({ command: process.execPath, args: [script], minBackoffMs: 50, maxBackoffMs: 200, log: (m) => logs.push(m) });
    await waitFor(() => sup.restarts === 2 && !!sup.child, 5000, 'two restarts');
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.readFileSync(counter, 'utf8')).toBe('3');
    await sup.stop();
    expect(fs.existsSync(counter + '.term')).toBe(true); // graceful signal reached the child
    expect(logs.some((l) => /restart #2/.test(l))).toBe(true);
  });
});
