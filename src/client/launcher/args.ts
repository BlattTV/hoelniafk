import path from 'node:path';
import type { InstalledVersion } from './installer.js';
import { rulesAllow, type Platform } from './rules.js';
import type { ArgumentValue } from './types.js';

export interface LaunchAuth {
  username: string;
  /** UUID without dashes. */
  uuid: string;
  accessToken: string;
  userType: 'msa' | 'legacy';
  xuid?: string;
}

export interface LaunchOptions {
  gameDir: string;
  auth: LaunchAuth;
  /** Join this server directly (Quick Play on 1.20+, --server/--port on older versions). */
  server?: { host: string; port: number };
  memoryMb: number;
  width?: number;
  height?: number;
  extraJvmArgs?: string[];
  launcherName?: string;
}

function expand(values: ArgumentValue[] | undefined, platform: Platform, features: Record<string, boolean>): string[] {
  const out: string[] = [];
  for (const v of values ?? []) {
    if (typeof v === 'string') out.push(v);
    else if (rulesAllow(v.rules, platform, features)) out.push(...(Array.isArray(v.value) ? v.value : [v.value]));
  }
  return out;
}

/** Builds the full java command line (without the java executable) for an installed version. */
export function buildLaunchArgs(v: InstalledVersion, o: LaunchOptions, platform: Platform): string[] {
  const sep = platform.name === 'windows' ? ';' : ':';
  const quick = !!o.server && v.supportsQuickPlay;
  const features: Record<string, boolean> = {
    is_demo_user: false,
    has_custom_resolution: !!(o.width && o.height),
    has_quick_plays_support: quick,
    is_quick_play_multiplayer: quick,
    is_quick_play_singleplayer: false,
    is_quick_play_realms: false,
  };
  const vars: Record<string, string> = {
    auth_player_name: o.auth.username,
    version_name: v.id,
    game_directory: o.gameDir,
    assets_root: v.assetsRoot,
    game_assets: v.assetsRoot,
    assets_index_name: v.assetIndexId,
    auth_uuid: o.auth.uuid,
    auth_access_token: o.auth.accessToken,
    auth_session: o.auth.accessToken,
    clientid: '',
    auth_xuid: o.auth.xuid ?? '',
    user_type: o.auth.userType,
    user_properties: '{}',
    version_type: v.json.type ?? 'release',
    natives_directory: v.nativesDir,
    launcher_name: o.launcherName ?? 'hoelni-client-suite',
    launcher_version: '0.2',
    classpath: v.classpath.join(sep),
    classpath_separator: sep,
    library_directory: v.librariesDir,
    resolution_width: String(o.width ?? 1280),
    resolution_height: String(o.height ?? 720),
    quickPlayMultiplayer: o.server ? `${o.server.host}:${o.server.port}` : '',
    quickPlayPath: path.join(o.gameDir, 'quickPlay', 'log.json'),
    quickPlaySingleplayer: '',
    quickPlayRealms: '',
  };
  const sub = (s: string) => s.replace(/\$\{([a-zA-Z_]+)\}/g, (_, k) => vars[k] ?? '');

  let jvm = expand(v.json.arguments?.jvm, platform, features);
  if (!v.json.arguments?.jvm?.length) {
    // pre-1.13 versions carry no jvm arguments
    jvm = ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'];
  }
  const game = v.json.arguments?.game?.length ? expand(v.json.arguments.game, platform, features) : (v.json.minecraftArguments ?? '').split(' ').filter(Boolean);

  const out = [
    `-Xmx${o.memoryMb}M`,
    `-Xms${Math.min(512, o.memoryMb)}M`,
    '-XX:+UseG1GC',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:G1NewSizePercent=20',
    '-XX:MaxGCPauseMillis=50',
    ...(v.logConfigArg ? [v.logConfigArg] : []),
    ...(o.extraJvmArgs ?? []),
    ...jvm.map(sub),
    v.mainClass,
    ...game.map(sub),
  ];
  if (o.server && !quick) out.push('--server', o.server.host, '--port', String(o.server.port));
  // Remove options whose value became empty (e.g. --clientId "" on some versions) – the game rejects them.
  const cleaned: string[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i].startsWith('--') && i + 1 < out.length && out[i + 1] === '' ) {
      i++;
      continue;
    }
    cleaned.push(out[i]);
  }
  return cleaned;
}
