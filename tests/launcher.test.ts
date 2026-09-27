/**
 * LOCAL INTEGRATION: the Minecraft launcher against a local mirror serving
 * format-correct Mojang/Fabric metadata (tests/fixtures/fakeMojang.ts), plus the
 * connection forwarder's handshake handling.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHandshake, parseHandshake, startForwarder } from '../src/client/forwarder.js';
import { offlineUuid, parseLogLine, writeOptions } from '../src/client/instance.js';
import { buildLaunchArgs } from '../src/client/launcher/args.js';
import { applyMirror, Downloader } from '../src/client/launcher/download.js';
import { Installer } from '../src/client/launcher/installer.js';
import { rulesAllow, type Platform } from '../src/client/launcher/rules.js';
import { startFakeMojang, type FakeMojang } from './fixtures/fakeMojang.js';

const linux: Platform = { name: 'linux', arch: 'x86_64', version: '6.0' };
const windows: Platform = { name: 'windows', arch: 'x86_64', version: '10.0' };
let fake: FakeMojang;
let tmp: string;

beforeAll(async () => {
  fake = await startFakeMojang();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-launcher-'));
});
afterAll(async () => {
  await fake?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('rules', () => {
  it('evaluates os/feature rules like the official launcher (last match wins)', () => {
    expect(rulesAllow(undefined, linux)).toBe(true);
    expect(rulesAllow([{ action: 'allow', os: { name: 'windows' } }], linux)).toBe(false);
    expect(rulesAllow([{ action: 'allow', os: { name: 'windows' } }], windows)).toBe(true);
    expect(rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], linux)).toBe(true);
    expect(rulesAllow([{ action: 'allow', features: { is_quick_play_multiplayer: true } }], linux, { is_quick_play_multiplayer: true })).toBe(true);
    expect(rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], linux, {})).toBe(false);
  });

  it('rewrites official hosts to a mirror', () => {
    expect(applyMirror('https://libraries.minecraft.net/a/b.jar', { 'libraries.minecraft.net': 'http://m/x/' })).toBe('http://m/x/a/b.jar');
    expect(applyMirror('https://other.host/a', { 'libraries.minecraft.net': 'http://m' })).toBe('https://other.host/a');
  });
});

describe('installer', () => {
  it('installs vanilla: client jar, platform libraries, natives, assets, logging config (SHA-1 verified)', async () => {
    const root = path.join(tmp, 'vanilla');
    const inst = new Installer(root, new Downloader(fake.mirrors), linux);
    const stages = new Set<string>();
    const v = await inst.install({ version: 'latest-release', loader: 'vanilla' }, (s) => stages.add(s));
    expect(v.id).toBe('1.20.1');
    expect(v.mainClass).toBe('net.minecraft.client.main.Main');
    expect(v.supportsQuickPlay).toBe(true);
    expect(v.javaComponent).toBe('java-runtime-gamma');
    expect(stages).toEqual(new Set(['libraries', 'assets']));
    expect(v.classpath.some((c) => c.endsWith(path.join('versions', '1.20.1', '1.20.1.jar')))).toBe(true);
    expect(v.classpath.some((c) => c.includes('brigadier'))).toBe(true);
    expect(v.classpath.some((c) => c.includes('windows-only'))).toBe(false); // os rule
    expect(v.classpath.some((c) => c.includes('natives'))).toBe(false); // natives are extracted, not on the classpath
    for (const c of v.classpath) expect(fs.existsSync(c)).toBe(true);
    expect(fs.readFileSync(path.join(v.nativesDir, 'liblwjgl64.so'), 'utf8')).toBe('ELF');
    expect(fs.existsSync(path.join(v.nativesDir, 'META-INF'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'assets', 'indexes', '5.json'))).toBe(true);
    expect(fs.readdirSync(path.join(root, 'assets', 'objects')).length).toBe(2);
    expect(v.logConfigArg).toMatch(/^-Dlog4j\.configurationFile=.*client-1\.12\.xml$/);
    // second install is served from disk (no library re-download)
    const before = fake.requests.length;
    await inst.install({ version: '1.20.1', loader: 'vanilla' });
    expect(fake.requests.slice(before).filter((r) => r.endsWith('.jar'))).toEqual([]);
  });

  it('selects the natives classifier for Windows', async () => {
    const inst = new Installer(path.join(tmp, 'win'), new Downloader(fake.mirrors), windows);
    const v = await inst.install({ version: '1.20.1', loader: 'vanilla' });
    expect(fs.existsSync(path.join(v.nativesDir, 'lwjgl64.dll'))).toBe(true);
    expect(v.classpath.some((c) => c.includes('windows-only'))).toBe(true);
  });

  it('installs Fabric on top of vanilla (profile merge, maven libraries, newer asm wins)', async () => {
    const inst = new Installer(path.join(tmp, 'fabric'), new Downloader(fake.mirrors), linux);
    const v = await inst.install({ version: '1.20.1', loader: 'fabric' });
    expect(v.id).toBe('fabric-loader-0.16.0-1.20.1');
    expect(v.gameVersion).toBe('1.20.1');
    expect(v.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient');
    const asm = v.classpath.filter((c) => c.includes(`${path.sep}asm${path.sep}`));
    expect(asm).toHaveLength(1);
    expect(asm[0]).toContain('9.6');
    expect(v.classpath.some((c) => c.includes('fabric-loader-0.16.0.jar'))).toBe(true);
    expect(v.json.arguments?.jvm).toContain('-DFabricMcEmu=true');
    expect(v.supportsQuickPlay).toBe(true);
  });

  it('rejects files whose checksum does not match', async () => {
    const f = await startFakeMojang();
    try {
      f.corrupt('/piston-data.mojang.com/v1/objects/client/1.20.1.jar');
      const inst = new Installer(path.join(tmp, 'corrupt'), new Downloader(f.mirrors, 4, 1), linux);
      await expect(inst.install({ version: '1.20.1', loader: 'vanilla' })).rejects.toThrow(/Checksum mismatch/);
      expect(fs.existsSync(path.join(tmp, 'corrupt', 'versions', '1.20.1', '1.20.1.jar'))).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('installs the Mojang Java runtime (executable, links, completion marker)', async () => {
    const inst = new Installer(path.join(tmp, 'java'), new Downloader(fake.mirrors), linux);
    const exe = await inst.ensureJava('java-runtime-gamma');
    expect(exe).toMatch(/runtime[/\\]java-runtime-gamma[/\\]linux[/\\]bin[/\\]java$/);
    if (process.platform !== 'win32') {
      expect(fs.statSync(exe).mode & 0o111).not.toBe(0);
      expect(fs.readlinkSync(path.join(path.dirname(exe), 'java-link'))).toBe('java');
    }
    const n = fake.requests.length;
    expect(await inst.ensureJava('java-runtime-gamma')).toBe(exe);
    expect(fake.requests.length).toBe(n); // marker: no second download
    await expect(inst.ensureJava('java-runtime-unknown')).rejects.toThrow(/configure client\.javaPath/);
  });
});

describe('launch arguments', () => {
  it('builds the java command line with quick play, auth and classpath', async () => {
    const inst = new Installer(path.join(tmp, 'vanilla'), new Downloader(fake.mirrors), linux);
    const v = await inst.install({ version: '1.20.1', loader: 'vanilla' });
    const args = buildLaunchArgs(v, { gameDir: '/games/one', auth: { username: 'Player01', uuid: 'abc', accessToken: 'TOKEN123456', userType: 'msa' }, server: { host: '127.0.0.1', port: 40000 }, memoryMb: 3072 }, linux);
    const at = (k: string) => args[args.indexOf(k) + 1];
    expect(args[0]).toBe('-Xmx3072M');
    expect(args).toContain('net.minecraft.client.main.Main');
    expect(args.indexOf('-cp')).toBeLessThan(args.indexOf('net.minecraft.client.main.Main'));
    expect(at('-cp').split(':')).toEqual(v.classpath);
    expect(at('--username')).toBe('Player01');
    expect(at('--accessToken')).toBe('TOKEN123456');
    expect(at('--userType')).toBe('msa');
    expect(at('--quickPlayMultiplayer')).toBe('127.0.0.1:40000');
    expect(args).not.toContain('--server');
    expect(args).not.toContain('--demo');
    expect(args).not.toContain('--clientId'); // empty value removed
    expect(args).not.toContain('-XstartOnFirstThread'); // osx only
    expect(args.some((a) => a.includes('${'))).toBe(false);
    expect(args.find((a) => a.startsWith('-Djava.library.path='))).toBe(`-Djava.library.path=${v.nativesDir}`);
    const win = buildLaunchArgs(v, { gameDir: 'C:\\g', auth: { username: 'P', uuid: 'u', accessToken: '0', userType: 'legacy' }, memoryMb: 2048 }, windows);
    expect(win[win.indexOf('-cp') + 1]).toContain(';');
    expect(win.some((a) => a.startsWith('-XX:HeapDumpPath'))).toBe(true);
    expect(win).not.toContain('--quickPlayMultiplayer');
  });

  it('falls back to --server/--port for versions without quick play', async () => {
    const inst = new Installer(path.join(tmp, 'vanilla'), new Downloader(fake.mirrors), linux);
    const v = { ...(await inst.install({ version: '1.20.1', loader: 'vanilla' })), supportsQuickPlay: false };
    const args = buildLaunchArgs(v, { gameDir: '/g', auth: { username: 'P', uuid: 'u', accessToken: '0', userType: 'legacy' }, server: { host: 'localhost', port: 25570 }, memoryMb: 2048 }, linux);
    expect(args.slice(-4)).toEqual(['--server', 'localhost', '--port', '25570']);
    expect(args).not.toContain('--quickPlayMultiplayer');
  });
});

describe('instance helpers', () => {
  it('writes options.txt: forced settings win, user settings are kept', () => {
    const dir = path.join(tmp, 'opts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'options.txt'), 'pauseOnLostFocus:true\nrenderDistance:16\nfov:0.5\n');
    writeOptions(dir);
    const t = fs.readFileSync(path.join(dir, 'options.txt'), 'utf8');
    expect(t).toContain('pauseOnLostFocus:false');
    expect(t).toContain('renderDistance:16');
    expect(t).toContain('fov:0.5');
    expect(t).toContain('onboardAccessibility:false');
  });

  it('computes offline UUIDs like the server and parses vanilla log lines', () => {
    expect(offlineUuid('Notch')).toBe('b50ad385829d3141a2167e7d7539ba7f');
    expect(parseLogLine('[12:00:01] [Render thread/INFO]: [System] [CHAT] You have 3 stars')).toEqual({ type: 'chat', text: 'You have 3 stars' });
    expect(parseLogLine('[12:00:01] [Render thread/INFO]: [CHAT] <Bob> §ahi')).toEqual({ type: 'chat', text: '<Bob> hi' });
    expect(parseLogLine('[12:00:02] [Render thread/INFO]: Client disconnected with reason: You are banned')).toEqual({ type: 'disconnect', reason: 'You are banned' });
    expect(parseLogLine('[12:00:00] [Render thread/INFO]: Connecting to 127.0.0.1, 40000')).toEqual({ type: 'connecting', target: '127.0.0.1:40000' });
    expect(parseLogLine('[12:00:00] [Render thread/INFO]: Loaded 7 recipes')).toBeNull();
  });
});

describe('forwarder', () => {
  it('parses and rebuilds handshakes (including partial data and FML suffixes)', () => {
    const hs = buildHandshake({ protocol: 763, host: 'play.example.net\0FML3\0', port: 25565, nextState: 2 });
    expect(parseHandshake(hs.subarray(0, 5))).toBeNull();
    expect(parseHandshake(Buffer.concat([hs, Buffer.from([1, 2, 3])]))).toEqual({ protocol: 763, host: 'play.example.net\0FML3\0', port: 25565, nextState: 2, frameLength: hs.length });
  });

  it('routes through the bind IP, rewrites the handshake host and keeps following bytes', async () => {
    let seen: { remote?: string; data: Buffer } = { data: Buffer.alloc(0) };
    const upstream = net.createServer((s) => {
      seen.remote = s.remoteAddress;
      s.on('data', (d) => {
        seen.data = Buffer.concat([seen.data, d]);
        s.write('pong');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const port = (upstream.address() as net.AddressInfo).port;
    const order: string[] = [];
    const bindIp = process.platform === 'linux' ? '127.0.0.2' : '127.0.0.1';
    const fw = await startForwarder({
      target: { host: '127.0.0.1', port },
      network: { profile: { id: 1, identityId: 1, name: 'b', kind: 'BIND', localBindIp: bindIp } as any, secret: null },
      beforeLogin: async () => {
        order.push('beforeLogin');
        await new Promise((r) => setTimeout(r, 50));
      },
      onLoginUpstream: (i) => order.push(`upstream:${i.localAddress}`),
    });
    const c = net.connect(fw.port, '127.0.0.1');
    await new Promise<void>((r) => c.on('connect', () => r()));
    const hs = buildHandshake({ protocol: 763, host: 'localhost\0FML\0', port: fw.port, nextState: 2 });
    c.write(Buffer.concat([hs, Buffer.from('login-start')]));
    const reply = await new Promise<string>((r) => c.once('data', (d) => r(d.toString())));
    expect(reply).toBe('pong');
    const parsed = parseHandshake(seen.data)!;
    expect(parsed.host).toBe('127.0.0.1\0FML\0');
    expect(parsed.port).toBe(port);
    expect(seen.data.subarray(parsed.frameLength).toString()).toBe('login-start');
    expect(seen.remote).toBe(bindIp);
    expect(order).toEqual(['beforeLogin', `upstream:${bindIp}`]);
    expect(fw.stats().loginActive).toBe(true);
    // status pings do not trigger beforeLogin
    const c2 = net.connect(fw.port, '127.0.0.1');
    await new Promise<void>((r) => c2.on('connect', () => r()));
    c2.write(buildHandshake({ protocol: 763, host: 'x', port: 1, nextState: 1 }));
    await new Promise((r) => setTimeout(r, 100));
    expect(order.filter((o) => o === 'beforeLogin')).toHaveLength(1);
    c.destroy();
    c2.destroy();
    await fw.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });
});
