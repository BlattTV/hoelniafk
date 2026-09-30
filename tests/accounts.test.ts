/**
 * Account library: Microsoft and Discord accounts added on their own and linked to identities by
 * hand. Linking moves an account (and its Minecraft login) – never two identities on one login.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from '../src/core/db.js';
import { buildServer } from '../src/web/server.js';
import { createTestSuite } from './helpers.js';

const tokenOf = async (t: Awaited<ReturnType<typeof createTestSuite>>, identityId: number) => {
  const iv = t.suite.vault.forIdentity(identityId);
  return iv.get(iv.ref('minecraft'));
};

describe('account library', () => {
  it('adds accounts on their own, links them, moves them with the Minecraft login and keeps them when unlinked', async () => {
    const t = await createTestSuite();
    const s = t.suite;
    const a = s.identities.create({ label: 'Alpha' }).identity.id;
    const b = s.identities.create({ label: 'Beta' }).identity.id;

    const ms = s.accounts.create({ kind: 'microsoft', email: 'Alt07@Outlook.com', label: 'Alt 7' });
    expect(ms).toMatchObject({ kind: 'microsoft', email: 'alt07@outlook.com', identityId: null });
    expect(ms.partition).toMatch(/^persist:hoelni-ms-acc-[0-9a-f]{12}$/);
    expect(() => s.accounts.create({ kind: 'microsoft', email: 'alt07@outlook.com' })).toThrow(/already in the library/);
    expect(() => s.accounts.create({ kind: 'microsoft', email: 'nope' })).toThrow(/e-mail/);

    // link to Alpha → Minecraft sign-in for Alpha (fake Microsoft) → token in Alpha's vault
    await s.accounts.link(ms.id, a);
    expect(s.repo.getMinecraft(a)).toMatchObject({ authType: 'microsoft', msaAccount: 'alt07@outlook.com' });
    await s.auth.authenticate(a);
    expect(s.repo.getMinecraft(a)?.authStatus).toBe('AUTHENTICATED');
    expect(await tokenOf(t, a)).toContain('mc-token-for-alt07@outlook.com');

    // move it to Beta: the login moves along, Alpha has no Microsoft account any more
    await s.accounts.link(ms.id, b);
    expect(s.repo.getAccount(ms.id).identityId).toBe(b);
    expect(s.repo.getMinecraft(a)?.msaAccount).toBeNull();
    expect(await tokenOf(t, a)).toBeNull();
    expect(await tokenOf(t, b)).toContain('mc-token-for-alt07@outlook.com');
    expect(s.repo.getMinecraft(b)).toMatchObject({ msaAccount: 'alt07@outlook.com', username: 'Player07' });
    await new Promise((r) => setTimeout(r, 50)); // background sign-in with the saved login
    expect(s.repo.getMinecraft(b)?.authStatus).toBe('AUTHENTICATED');

    // a second Microsoft account linked to Beta replaces the first – that one goes back to the library
    const ms2 = s.accounts.create({ kind: 'microsoft', email: 'alt08@outlook.com' });
    await s.accounts.link(ms2.id, b);
    expect(s.repo.getAccount(ms.id).identityId).toBeNull();
    expect(s.repo.getAccount(ms.id).username).toBe('Player07'); // remembered for the overview
    expect(await tokenOf(t, b)).toBeNull(); // Alt 7's login is kept with the account, not with Beta
    await s.accounts.link(ms.id, a);
    expect(await tokenOf(t, a)).toContain('mc-token-for-alt07@outlook.com');

    // Discord: account on its own, marked as set up, linked
    const dc = s.accounts.create({ kind: 'discord', label: 'Main DC', username: 'hoelni_alt' });
    expect(() => s.accounts.create({ kind: 'discord', username: 'a b' })).toThrow(/Discord usernames/);
    s.accounts.update(dc.id, { ready: true });
    await s.accounts.link(dc.id, b);
    expect(s.repo.getDiscord(b)).toMatchObject({ oauthState: 'CONNECTED', username: 'hoelni_alt' });
    await s.accounts.link(dc.id, null);
    expect(s.repo.getDiscord(b)?.oauthState).toBe('NONE');
    expect(s.repo.getAccount(dc.id)).toMatchObject({ identityId: null, ready: true });

    // deleting an identity puts its accounts (with their logins) back into the library
    await s.identities.delete(a);
    expect(s.repo.getAccount(ms.id).identityId).toBeNull();
    await s.accounts.link(ms.id, b);
    expect(await tokenOf(t, b)).toContain('mc-token-for-alt07@outlook.com');

    // removing an account deletes its stored login too
    await s.accounts.link(ms.id, null);
    await s.accounts.remove(ms.id);
    expect(await t.store.list('vault://app/accounts/')).toEqual([]);
    expect(() => s.repo.getAccount(ms.id)).toThrow(/not found/);
  });

  it('the Microsoft sign-in of an identity and its Discord setup create library entries; the windows use the account profile', async () => {
    const t = await createTestSuite();
    const s = t.suite;
    const id = s.identities.create({ label: 'Gamma' }).identity.id;
    await s.microsoft.connect(id, 'gamma01@outlook.com', 1000);
    const ms = s.repo.accountOf(id, 'microsoft')!;
    expect(ms).toMatchObject({ email: 'gamma01@outlook.com', partition: `persist:hoelni-ms-${id}` }); // former window profile kept
    s.discord.markReady(id, 'gamma_dc');
    const dc = s.repo.accountOf(id, 'discord')!;
    expect(dc).toMatchObject({ ready: true, username: 'gamma_dc', partition: `persist:hoelni-discord-${id}` });
    // unlinking from the identity keeps the account in the library
    await s.microsoft.unlink(id);
    await s.discord.disconnect(id);
    expect(s.repo.listAccounts().map((a) => a.identityId)).toEqual([null, null]);

    const { app } = await buildServer(s, { apiToken: 'tok-1' });
    const headers = { host: '127.0.0.1:7420', 'x-hoelni-token': 'tok-1' };
    const win = (await app.inject({ method: 'GET', url: `/api/accounts/${ms.id}/window`, headers })).json();
    expect(win).toMatchObject({ id: ms.id, kind: 'microsoft', partition: `persist:hoelni-ms-${id}` });
    const outlook = await app.inject({ method: 'GET', url: `/api/accounts/${ms.id}/open?to=outlook&token=tok-1`, headers: { host: '127.0.0.1:7420' } });
    expect(outlook.headers.location).toBe('https://outlook.live.com/mail/0/');
    expect((await app.inject({ method: 'GET', url: `/api/accounts/${dc.id}/open?to=register&token=tok-1`, headers: { host: '127.0.0.1:7420' } })).headers.location).toBe('https://discord.com/register');
    expect((await app.inject({ method: 'GET', url: `/api/accounts/${dc.id}/open?to=evil&token=tok-1`, headers: { host: '127.0.0.1:7420' } })).statusCode).toBe(400);
    // link through the API
    const linked = (await app.inject({ method: 'POST', url: `/api/accounts/${dc.id}/link`, payload: { identityId: id }, headers })).json();
    expect(linked.identityId).toBe(id);
    // the desktop window of an identity without a Discord account creates one (with its old profile if free)
    const other = s.identities.create({ label: 'Delta' }).identity.id;
    const w2 = (await app.inject({ method: 'POST', url: `/api/identities/${other}/accounts/discord/window`, payload: {}, headers })).json();
    expect(w2.partition).toBe(`persist:hoelni-discord-${other}`);
    expect(s.repo.accountOf(other, 'discord')?.id).toBe(w2.id);
  });

  it('migration: existing Microsoft and Discord logins become library entries with their browser profiles', () => {
    const db = openDatabase(':memory:');
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    const rows = db.prepare('SELECT count(*) AS n FROM accounts').get() as { n: number };
    expect(rows.n).toBe(0);
    // simulate a v5 database with data: run the v6 inserts on fresh rows
    const ts = new Date().toISOString();
    db.prepare("INSERT INTO identities (id, number, label, settings_json, created_at, updated_at) VALUES (1, 1, 'Old', '{}', ?, ?)").run(ts, ts);
    db.prepare("INSERT INTO minecraft_identities (identity_id, username, auth_type, auth_status, msa_account) VALUES (1, 'OldPlayer', 'microsoft', 'AUTHENTICATED', 'old@outlook.com')").run();
    db.prepare("INSERT INTO discord_identities (identity_id, username, oauth_state) VALUES (1, 'old_dc', 'CONNECTED')").run();
    db.exec(`INSERT INTO accounts (kind, label, email, username, partition, ready, identity_id, created_at, updated_at)
      SELECT 'microsoft', '', msa_account, username, 'persist:hoelni-ms-' || identity_id, 1, identity_id, 'x', 'x' FROM minecraft_identities WHERE auth_type = 'microsoft' AND msa_account IS NOT NULL;
      INSERT INTO accounts (kind, label, email, username, partition, ready, identity_id, created_at, updated_at)
      SELECT 'discord', '', NULL, username, 'persist:hoelni-discord-' || identity_id, 1, identity_id, 'x', 'x' FROM discord_identities WHERE oauth_state = 'CONNECTED';`);
    const list = db.prepare('SELECT kind, email, username, partition, identity_id FROM accounts ORDER BY kind').all();
    expect(list).toEqual([
      { kind: 'discord', email: null, username: 'old_dc', partition: 'persist:hoelni-discord-1', identity_id: 1 },
      { kind: 'microsoft', email: 'old@outlook.com', username: 'OldPlayer', partition: 'persist:hoelni-ms-1', identity_id: 1 },
    ]);
  });
});
