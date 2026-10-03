/**
 * Settings sync between PCs of one backend account: snapshot merge (nothing is lost, deletions only
 * when the other PC deleted on purpose), encryption, and the full flow through the backend with
 * the active/standby rule (only one PC runs the sessions).
 */
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error – plain ESM backend package without type declarations
import { Accounts } from '../backend/src/accounts.mjs';
// @ts-expect-error – see above
import { openDb } from '../backend/src/db.mjs';
// @ts-expect-error – see above
import { Relay } from '../backend/src/relay.mjs';
// @ts-expect-error – see above
import { createBackendServer } from '../backend/src/server.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashesOf, SnapshotIO } from '../src/sync/snapshot.js';
import { openBlob, parseBlob, seal, unwrapKey, wrapKey } from '../src/sync/syncService.js';
import { createTestSuite, waitFor } from './helpers.js';

type T = Awaited<ReturnType<typeof createTestSuite>>;
const ioOf = (t: T) => new SnapshotIO(t.suite.db, t.store, { deleteIdentity: (id) => t.suite.identities.delete(id) });
const byLabel = (t: T) => new Map(t.suite.repo.listIdentities().map((i) => [i.label, i]));

async function pcWithData(): Promise<T> {
  const t = await createTestSuite();
  const s = t.suite;
  const smp = s.repo.upsertServer({ name: 'SMP', host: 'mc.example.com', port: 25565 });
  const lobby = s.repo.upsertServer({ name: 'Lobby', host: 'lobby.example.com', port: 25566 });
  const alpha = s.identities.create({ label: 'Alpha' }).identity.id;
  const beta = s.identities.create({ label: 'Beta', settings: { ui: { tags: ['main'] } } as any }).identity.id;
  s.repo.upsertMinecraft(alpha, { username: 'Alpha01', authType: 'offline' });
  s.repo.assignServer(alpha, { serverId: smp.id });
  s.repo.assignServer(beta, { serverId: lobby.id });
  s.repo.setDesiredState(alpha, smp.id, 'ONLINE');
  // a Microsoft identity with its Minecraft login in the vault
  const ms = s.accounts.create({ kind: 'microsoft', email: 'alt07@outlook.com', label: 'Alt 7' });
  await s.accounts.link(ms.id, beta);
  await s.auth.authenticate(beta);
  // proxy pool with a password, a macro for Alpha on SMP
  await s.proxies.import('socks5://pooluser:pool-secret@203.0.113.9:1080');
  s.macros.save({ name: 'Link', trigger: { type: 'spawn' }, blocks: [{ type: 'command', text: 'link' }], identityIds: [alpha], serverIds: [smp.id] });
  return t;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

describe('settings sync: merge', () => {
  it('a new PC gets everything (with logins and passwords) and keeps its own identities', async () => {
    const a = await pcWithData();
    const b = await createTestSuite();
    const own = b.suite.identities.create({ label: 'Laptop only' }).identity; // number 1 – taken on PC A too
    const fromA = await ioOf(a).export();
    const r = await ioOf(b).merge(fromA, {});
    expect(r.problems).toEqual([]);
    expect(r.deleted).toBe(0);
    const ids = byLabel(b);
    expect([...ids.keys()].sort()).toEqual(['Alpha', 'Beta', 'Laptop only']);
    expect(ids.get('Laptop only')!.number).toBe(own.number); // the PC's own identity is untouched
    expect(new Set([...ids.values()].map((i) => i.number)).size).toBe(3); // numbers unique
    expect(ids.get('Beta')!.settings.ui.tags).toEqual(['main']);
    // servers, assignments, desired state, Minecraft
    const smp = b.suite.repo.listServers().find((x) => x.name === 'SMP')!;
    const alpha = ids.get('Alpha')!.id;
    expect(b.suite.repo.getAssignment(alpha, smp.id)).toBeTruthy();
    expect(b.suite.repo.getMinecraft(alpha)).toMatchObject({ username: 'Alpha01', authType: 'offline' });
    // Beta's Microsoft login came along (token in the vault of Beta on this PC)
    const beta = ids.get('Beta')!.id;
    expect(b.suite.repo.getMinecraft(beta)).toMatchObject({ msaAccount: 'alt07@outlook.com', authStatus: 'AUTHENTICATED' });
    const iv = b.suite.vault.forIdentity(beta);
    expect(await iv.get(iv.ref('minecraft'))).toContain('mc-token-for-alt07@outlook.com');
    // account library entry linked to Beta, with its own (new) browser profile
    const acc = b.suite.repo.listAccounts().find((x) => x.email === 'alt07@outlook.com')!;
    expect(acc.identityId).toBe(beta);
    // its window is new on this PC: listed under "Sign in on this PC" (never on the PC it came from)
    expect(b.suite.accounts.list().find((x) => x.id === acc.id)!.loginPending).toBe(true);
    expect(a.suite.accounts.list().every((x) => !x.loginPending)).toBe(true);
    b.suite.accounts.loginDone(acc.id);
    expect(b.suite.accounts.list().find((x) => x.id === acc.id)!.loginPending).toBe(false);
    // proxy with its password, macro mapped to the local ids
    const proxy = b.suite.proxies.list()[0];
    expect(proxy).toMatchObject({ host: '203.0.113.9', port: 1080 });
    expect(await b.store.get(`vault://app/proxy/${proxy.id}`)).toContain('pool-secret');
    const macro = b.suite.macros.list()[0];
    expect(macro).toMatchObject({ name: 'Link', identityIds: [alpha], serverIds: [smp.id] });
    // nothing on PC A changes by merging its own data back
    const back = await ioOf(a).merge(await ioOf(b).export(), hashesOf(fromA));
    expect(back.deleted).toBe(0);
    expect([...byLabel(a).keys()].sort()).toEqual(['Alpha', 'Beta', 'Laptop only']); // the laptop's identity arrives on A
  });

  it('changes go both ways; deletions only when the other PC deleted on purpose; the first sync never deletes', async () => {
    const a = await pcWithData();
    const b = await createTestSuite();
    const s0 = await ioOf(a).export();
    await ioOf(b).merge(s0, {});
    const agreed = await ioOf(b).export();
    const base = hashesOf(agreed);
    // B renames Alpha and deletes Beta; A meanwhile changes nothing
    const bAlpha = byLabel(b).get('Alpha')!.id;
    b.suite.repo.updateIdentity(bAlpha, { label: 'Alpha (renamed)' });
    await b.suite.identities.delete(byLabel(b).get('Beta')!.id);
    const fromB = await ioOf(b).export();
    const r = await ioOf(a).merge(fromB, base);
    expect(r).toMatchObject({ deleted: 1, problems: [] });
    expect([...byLabel(a).keys()]).toEqual(['Alpha (renamed)']);
    expect(a.suite.repo.listAccounts()[0].identityId).toBeNull(); // Beta's account went back to the library on both PCs
    // a first sync (no base) with an empty PC never removes anything
    const c = await pcWithData();
    const r2 = await ioOf(c).merge((await createTestSuite().then((x) => ioOf(x).export())), {});
    expect(r2.deleted).toBe(0);
    expect(byLabel(c).size).toBe(2);
    // changed here AND deleted there → kept here
    const d = await pcWithData();
    const dBase = hashesOf(await ioOf(d).export());
    d.suite.repo.updateIdentity(byLabel(d).get('Alpha')!.id, { label: 'Alpha (edited here)' });
    const remoteWithout = await ioOf(d).export();
    const alphaSid = Object.entries(remoteWithout.identities).find(([, e]) => e.label === 'Alpha (edited here)')![0];
    delete remoteWithout.identities[alphaSid];
    const r3 = await ioOf(d).merge(remoteWithout, dBase);
    expect(r3.deleted).toBe(0);
    expect(byLabel(d).has('Alpha (edited here)')).toBe(true);
  });

  it('the same Minecraft account set up on both PCs on their own is reported, not merged into the wrong identity', async () => {
    const a = await pcWithData();
    const b = await createTestSuite();
    const mine = b.suite.identities.create({ label: 'Mine' }).identity.id;
    b.suite.repo.upsertMinecraft(mine, { username: 'Player07', authType: 'microsoft', msaAccount: 'alt07@outlook.com' } as any);
    const r = await ioOf(b).merge(await ioOf(a).export(), {});
    expect(r.problems.join('\n')).toMatch(/Beta.*already used by identity #01/);
    expect(byLabel(b).has('Alpha')).toBe(true);
    expect(b.suite.repo.getMinecraft(mine)?.msaAccount).toBe('alt07@outlook.com');
  });
});

describe('settings sync: encryption', () => {
  it('the backend only stores ciphertext; the password unlocks the data key', async () => {
    const t = await pcWithData();
    const snap = await ioOf(t).export();
    const dk = crypto.randomBytes(32);
    const wrap = wrapKey(dk, 'account-password-1');
    const sealed = seal(snap, dk, wrap);
    const text = sealed.toString('utf8');
    for (const secret of ['pool-secret', 'mc-token-for-alt07', 'Alpha01', 'alt07@outlook.com']) expect(text).not.toContain(secret);
    expect(unwrapKey(wrap, 'wrong-password')).toBeNull();
    const key = unwrapKey(wrap, 'account-password-1')!;
    expect(key.equals(dk)).toBe(true);
    expect(openBlob(parseBlob(sealed), key)).toEqual(snap);
    expect(openBlob(parseBlob(sealed), crypto.randomBytes(32))).toBeNull();
  });
});

describe('settings sync through the backend + one active PC', () => {
  it('second PC: standby, gets identities and logins; "take over" moves the sessions; edits flow back', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-sync-'));
    const accounts = new Accounts(openDb(path.join(tmp, 'backend.db')));
    accounts.createUser('niklas', 'account-password-1', 'admin');
    const quiet = { info: () => undefined, error: () => undefined };
    const relay = new Relay(accounts, quiet);
    const server = createBackendServer({ accounts, relay, config: { trustProxy: false }, log: quiet });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    cleanups.push(async () => {
      relay.close();
      await new Promise((r) => server.close(r));
    });

    // PC A: existing setup, Alpha online
    const a = await pcWithData();
    const alphaA = byLabel(a).get('Alpha')!.id;
    const smpA = a.suite.repo.listServers().find((x) => x.name === 'SMP')!.id;
    a.suite.sessions.startReconciler();
    await a.suite.sessions.startSession(alphaA, smpA);
    await waitFor(() => a.bots.length === 1, 5000, 'A runs Alpha');
    a.bots[0].join();
    a.suite.repo.setSetting('backend.url', url);
    await a.suite.backend.login('niklas', 'account-password-1');
    await a.suite.sync.setup('niklas', 'account-password-1', { verified: true });
    await waitFor(() => a.suite.backend.status().state === 'online' && a.suite.backend.status().pcRole === 'active', 5000, 'A active');
    expect(a.suite.sync.status()).toMatchObject({ state: 'ok', version: 1 });
    expect(accounts.getSync(1).data.toString()).not.toContain('pool-secret');

    // PC B: fresh suite signs in with the same account → standby, everything arrives
    const b = await createTestSuite();
    cleanups.push(async () => {
      a.suite.sync.stop();
      b.suite.sync.stop();
      a.suite.backend.shutdown();
      b.suite.backend.shutdown();
    });
    b.suite.repo.setSetting('backend.url', url);
    b.suite.sessions.startReconciler();
    await b.suite.backend.login('niklas', 'account-password-1');
    await waitFor(() => b.suite.backend.status().pcRole === 'standby', 5000, 'B standby');
    expect(b.suite.sessions.standby).toMatch(/run on "Manager on/);
    await b.suite.sync.setup('niklas', 'account-password-1', { verified: true });
    expect([...byLabel(b).keys()].sort()).toEqual(['Alpha', 'Beta']);
    const alphaB = byLabel(b).get('Alpha')!.id;
    const smpB = b.suite.repo.listServers().find((x) => x.name === 'SMP')!.id;
    expect(b.suite.repo.getAssignment(alphaB, smpB)?.desiredState).toBe('ONLINE');
    await new Promise((r) => setTimeout(r, 300));
    expect(b.bots).toHaveLength(0); // standby: nothing starts on B
    expect(a.bots[0].quitCalled).toBe(false);
    // the backend lists both PCs, one active
    await waitFor(() => b.suite.backend.status().pcs.length === 2, 5000, 'both PCs listed');
    expect(b.suite.backend.status().pcs.filter((p) => p.active)).toHaveLength(1);

    // B takes over: A stops Alpha, B starts it – never both
    b.suite.backend.claim();
    await waitFor(() => a.suite.backend.status().pcRole === 'standby' && b.suite.backend.status().pcRole === 'active', 5000, 'roles switched');
    await waitFor(() => a.bots[0].quitCalled, 5000, 'A stopped Alpha');
    await waitFor(() => b.bots.length === 1, 5000, 'B runs Alpha');
    expect(a.suite.repo.getAssignment(alphaA, smpA)?.desiredState).toBe('ONLINE'); // desired state kept on A

    // an edit on B (now active) reaches A
    b.suite.repo.updateIdentity(alphaB, { label: 'Alpha (from laptop)' });
    b.suite.sync.schedule(false);
    await b.suite.sync.syncNow();
    await waitFor(() => byLabel(a).has('Alpha (from laptop)'), 10_000, 'edit arrived on A');
  }, 60_000);
});

describe('remote control: the sessions stay where they run, the control moves', () => {
  it('a standby PC and the control app steer the active PC through the backend', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-remote-'));
    const accounts = new Accounts(openDb(path.join(tmp, 'backend.db')));
    accounts.createUser('niklas', 'account-password-1', 'admin');
    const quiet = { info: () => undefined, error: () => undefined };
    const relay = new Relay(accounts, quiet);
    const server = createBackendServer({ accounts, relay, config: { trustProxy: false }, log: quiet });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const { buildServer } = await import('../src/web/server.js');

    const a = await pcWithData();
    const alphaA = byLabel(a).get('Alpha')!.id;
    const smpA = a.suite.repo.listServers().find((x) => x.name === 'SMP')!.id;
    a.suite.sessions.startReconciler();
    await a.suite.sessions.startSession(alphaA, smpA);
    await waitFor(() => a.bots.length === 1, 5000, 'A runs Alpha');
    a.bots[0].join();
    a.suite.repo.setSetting('backend.url', url);
    await buildServer(a.suite, { apiToken: 'tok-a' }); // wires the remote-control answers
    await a.suite.backend.login('niklas', 'account-password-1');
    await waitFor(() => a.suite.backend.status().pcRole === 'active' && a.suite.backend.status().state === 'online', 5000, 'A active');

    const b = await createTestSuite();
    b.suite.repo.setSetting('backend.url', url);
    const { app: appB } = await buildServer(b.suite, { apiToken: 'tok-b' });
    await b.suite.backend.login('niklas', 'account-password-1');
    await waitFor(() => b.suite.backend.remoteControl, 5000, 'B controls A');
    cleanups.push(async () => {
      for (const s of [a.suite, b.suite]) {
        s.sync.stop();
        s.backend.shutdown();
      }
      relay.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    });
    const hb = { host: '127.0.0.1:7420', 'x-hoelni-token': 'tok-b' };
    const sid = `${alphaA}:${smpA}`;

    // B (standby, nothing synchronized yet) shows A's live sessions …
    const list = (await appB.inject({ method: 'GET', url: '/api/sessions', headers: hb })).json();
    expect(list.find((x: any) => x.id === sid)).toMatchObject({ state: 'ONLINE' });
    // … and stops one on A – nothing starts on B
    expect((await appB.inject({ method: 'POST', url: `/api/sessions/${sid}/stop`, headers: hb })).statusCode).toBe(200);
    await waitFor(() => a.bots[0].quitCalled, 5000, 'A stopped Alpha');
    expect(b.bots).toHaveLength(0);
    // things of B itself stay on B
    expect((await appB.inject({ method: 'GET', url: '/api/backend', headers: hb })).json().pcRole).toBe('standby');

    // the control app: own device kind, REST + live events, no access to the vault
    const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'niklas', password: 'account-password-1', client: 'remote', name: 'Pixel' }) }).then((r) => r.json());
    const auth = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
    const rpc = (method: string, p: string, body?: unknown) => fetch(`${url}/api/remote/rpc`, { method: 'POST', headers: auth, body: JSON.stringify({ method, path: p, body }) });
    const st = await fetch(`${url}/api/remote/status`, { headers: auth }).then((r) => r.json());
    expect(st.active.name).toMatch(/Manager on/);
    expect(st.pcs).toHaveLength(2);
    expect((await rpc('GET', '/api/vault')).status).toBe(403);
    expect((await rpc('GET', `/api/identities/${byLabel(a).get('Beta')!.id}/discord/password`)).status).toBe(403);
    const events: any[] = [];
    const ctrl = new AbortController();
    void fetch(`${url}/api/remote/events`, { headers: auth, signal: ctrl.signal }).then(async (r) => {
      const reader = r.body!.getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += Buffer.from(value).toString();
        for (const m of buf.split('\n\n').slice(0, -1)) if (m.startsWith('data: ')) events.push(JSON.parse(m.slice(6)));
        buf = buf.split('\n\n').pop()!;
      }
    }).catch(() => undefined);
    cleanups.push(async () => ctrl.abort());
    await new Promise((r) => setTimeout(r, 300));
    expect((await rpc('POST', `/api/identities/${alphaA}/sessions/${smpA}/start`)).status).toBe(200);
    await waitFor(() => a.bots.length === 2, 5000, 'A starts Alpha again (control app)');
    a.bots[1].join();
    await waitFor(() => events.some((e) => e.type === 'session.state' && e.data?.state === 'ONLINE'), 5000, 'live event reached the app');
    const sessions = await rpc('GET', '/api/sessions').then((r) => r.json());
    expect(sessions.find((x: any) => x.id === sid).state).toBe('ONLINE');
    // without an active PC the app gets a clear answer
    a.suite.backend.shutdown();
    let status = 0;
    for (let i = 0; i < 50 && status !== 503; i++) {
      status = (await rpc('GET', '/api/sessions')).status;
      if (status !== 503) await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe(503);
  }, 60_000);
});
