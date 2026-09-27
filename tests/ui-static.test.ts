/** Static checks of the browser modules (no build step → catch missing imports early). */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.resolve('public/js');
const ui = fs.readFileSync(path.join(dir, 'ui.js'), 'utf8');
const uiExports = new Set([...ui.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]));

function modules(): string[] {
  const out: string[] = [];
  for (const d of [dir, path.join(dir, 'views')]) for (const f of fs.readdirSync(d)) if (f.endsWith('.js')) out.push(path.join(d, f));
  return out;
}

describe('browser modules', () => {
  it('only import helpers that exist and import every helper they call', () => {
    const problems: string[] = [];
    for (const file of modules()) {
      const src = fs.readFileSync(file, 'utf8');
      const m = src.match(/import \{([^}]*)\} from '\.\.?\/ui\.js'/);
      const imported = new Set((m?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean));
      for (const n of imported) if (!uiExports.has(n)) problems.push(`${path.basename(file)} imports missing ${n}`);
      if (file.endsWith('ui.js')) continue;
      for (const n of uiExports) {
        const called = new RegExp(`(?<![.\\w])${n}\\(`).test(src);
        if (called && !imported.has(n) && !new RegExp(`function ${n}\\b`).test(src)) problems.push(`${path.basename(file)} calls ${n} without importing it`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every named import between view modules exists', () => {
    const problems: string[] = [];
    for (const file of modules()) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/import \{([^}]*)\} from '(\.\.?\/[^']+)'/g)) {
        const target = path.resolve(path.dirname(file), m[2]);
        if (target.endsWith('ui.js')) continue;
        const tsrc = fs.readFileSync(target, 'utf8');
        for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
          if (!new RegExp(`export (?:async )?(?:function|const|let|class) ${n}\\b`).test(tsrc)) problems.push(`${path.basename(file)} imports ${n} from ${m[2]}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
