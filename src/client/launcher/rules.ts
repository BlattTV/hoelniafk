import os from 'node:os';
import type { Rule } from './types.js';

export interface Platform {
  /** Mojang OS name: windows | linux | osx */
  name: 'windows' | 'linux' | 'osx';
  /** Mojang arch: x86 | x86_64 | arm64 */
  arch: 'x86' | 'x86_64' | 'arm64';
  version: string;
}

export function currentPlatform(): Platform {
  const name = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x86_64';
  return { name, arch, version: os.release() };
}

/** Evaluates Mojang rules: the last matching rule wins; no rules = allowed. */
export function rulesAllow(rules: Rule[] | undefined, platform: Platform, features: Record<string, boolean> = {}): boolean {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const r of rules) {
    let matches = true;
    if (r.os) {
      if (r.os.name && r.os.name !== platform.name) matches = false;
      if (r.os.arch && r.os.arch !== platform.arch && !(r.os.arch === 'x86' && platform.arch === 'x86')) matches = false;
      if (r.os.version) {
        try {
          if (!new RegExp(r.os.version).test(platform.version)) matches = false;
        } catch {
          matches = false;
        }
      }
    }
    if (r.features) {
      for (const [k, v] of Object.entries(r.features)) if (!!features[k] !== v) matches = false;
    }
    if (matches) allowed = r.action === 'allow';
  }
  return allowed;
}

/** Mojang's Java runtime platform key. */
export function javaRuntimePlatform(p: Platform): string {
  if (p.name === 'windows') return p.arch === 'arm64' ? 'windows-arm64' : p.arch === 'x86' ? 'windows-x86' : 'windows-x64';
  if (p.name === 'osx') return p.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return p.arch === 'x86' ? 'linux-i386' : 'linux';
}

/** Maven coordinate "group:artifact:version[:classifier][@ext]" → relative path. */
export function mavenPath(coord: string): string {
  const [main, extPart] = coord.split('@');
  const parts = main.split(':');
  const [group, artifact, version, classifier] = parts;
  const ext = extPart ?? 'jar';
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}
