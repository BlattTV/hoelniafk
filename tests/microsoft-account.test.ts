/**
 * One Microsoft sign-in per identity → Outlook mailbox + Minecraft (Xbox Live chain),
 * with the fallback to the Minecraft sign-in code when the Azure app is not approved by Mojang.
 * Microsoft, Xbox Live and Minecraft services are local fakes (MOCK).
 */
import { describe, expect, it } from 'vitest';
import type { JsonHttp } from '../src/minecraft/xboxChain.js';
import { createTestSuite, settle } from './helpers.js';

const idToken = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

function fakes(opts: { approved: boolean }) {
  const tokenRequests: Array<Record<string, string>> = [];
  let rotation = 0;
  const oauthPost = async (_url: string, form: Record<string, string>) => {
    tokenRequests.push(form);
    rotation++;
    return {
      status: 200,
      json: {
        access_token: `ms-access-${form.scope?.includes('XboxLive') ? 'xbox' : 'outlook'}-${rotation}`,
        refresh_token: `ms-refresh-${rotation}`,
        expires_in: 3600,
        id_token: idToken({ email: 'Player.One@outlook.com', preferred_username: 'player.one@outlook.com' }),
      },
    };
  };
  const xboxCalls: string[] = [];
  const xboxHttp: JsonHttp = async (url, init) => {
    xboxCalls.push(url);
    if (url.endsWith('/user/authenticate')) {
      expect((init.body as any).Properties.RpsTicket).toMatch(/^d=ms-access-xbox-/);
      return { status: 200, json: { Token: 'xbl-user', DisplayClaims: { xui: [{ uhs: 'uhs123' }] } } };
    }
    if (url.endsWith('/xsts/authorize')) return { status: 200, json: { Token: 'xsts-token' } };
    if (url.endsWith('/login_with_xbox')) {
      expect((init.body as any).identityToken).toBe('XBL3.0 x=uhs123;xsts-token');
      return opts.approved ? { status: 200, json: { access_token: 'mc-access', expires_in: 86400 } } : { status: 403, json: { errorMessage: 'Invalid app registration' } };
    }
    if (url.endsWith('/minecraft/profile')) return { status: 200, json: { id: '0123456789abcdef0123456789abcdef', name: 'PlayerOne' } };
    if (url.endsWith('/player/certificates')) return { status: 200, json: { keyPair: { publicKey: 'PUB', privateKey: 'PRIV' }, publicKeySignature: 'c2ln', publicKeySignatureV2: 'c2lnMg==', expiresAt: '2026-10-01T00:00:00Z' } };
    return { status: 404, json: null };
  };
  return { tokenRequests, oauthPost, xboxHttp, xboxCalls };
}

async function signIn(suite: any, identityId: number) {
  const { url } = await suite.microsoft.begin(identityId);
  const u = new URL(url);
  const flow = await suite.oauth.complete(u.searchParams.get('state')!, 'auth-code');
  expect(flow.purpose).toEqual({ type: 'microsoft-account', identityId });
  return { url: u, result: await suite.microsoft.complete(identityId, flow.tokens) };
}

describe('one Microsoft sign-in for Outlook + Minecraft', () => {
  it('connects the Outlook mailbox and Minecraft from a single consent', async () => {
    const f = fakes({ approved: true });
    const { suite, mailServer } = await createTestSuite({ oauthPost: f.oauthPost, xboxHttp: f.xboxHttp });
    const id = suite.identities.create({ label: 'Quick01' }).identity.id;
    const { url, result } = await signIn(suite, id);

    // one consent covering both resources; the code is redeemed for Outlook only
    const scope = url.searchParams.get('scope')!;
    expect(scope).toContain('XboxLive.signin');
    expect(scope).toContain('https://outlook.office.com/IMAP.AccessAsUser.All');
    expect(f.tokenRequests[0].grant_type).toBe('authorization_code');
    expect(f.tokenRequests[0].scope).not.toContain('XboxLive');

    expect(result).toMatchObject({ email: 'player.one@outlook.com', minecraft: 'direct', username: 'PlayerOne' });
    const mailbox = suite.repo.getMailAccount(result.mailboxId);
    expect(mailbox).toMatchObject({ kind: 'microsoft', username: 'player.one@outlook.com', exclusiveIdentityId: id, imapHost: 'outlook.office365.com' });
    expect(suite.repo.getMailIdentity(id)).toMatchObject({ mailAccountId: result.mailboxId, address: 'player.one@outlook.com' });
    expect(suite.repo.getMinecraft(id)).toMatchObject({ username: 'PlayerOne', uuid: '01234567-89ab-cdef-0123-456789abcdef', authStatus: 'AUTHENTICATED', authType: 'microsoft' });

    // Minecraft session for the runtime comes from the same grant (Xbox scope on refresh)
    const session = await suite.auth.getJavaSession(id);
    expect(session).toMatchObject({ accessToken: 'mc-access', profile: { name: 'PlayerOne' } });
    expect(session.profileKeys?.publicPEM).toBe('PUB');
    expect(f.tokenRequests.some((r) => r.grant_type === 'refresh_token' && r.scope?.includes('XboxLive.signin'))).toBe(true);

    // IMAP uses an Outlook token from the grant
    await suite.mail.syncMailbox(result.mailboxId);
    await settle();
    expect(mailServer.authLog.at(-1)).toMatchObject({ mailbox: 'player.one@outlook.com', user: 'player.one@outlook.com' });
    expect(mailServer.authLog.at(-1)!.accessToken).toMatch(/^ms-access-outlook-/);

    // secrets: only in the vault (SQLite and audit never contain tokens)
    const dump = JSON.stringify(suite.db.prepare('SELECT * FROM mail_accounts').all()) + JSON.stringify(suite.db.prepare('SELECT * FROM minecraft_identities').all()) + JSON.stringify(suite.audit.list({ limit: 100 }));
    expect(dump).not.toMatch(/ms-refresh|ms-access|mc-access/);
    expect(await suite.microsoft.status(id)).toMatchObject({ linked: true, email: 'player.one@outlook.com', minecraft: 'direct', mailboxId: result.mailboxId });
    await suite.shutdown();
  });

  it('falls back to the Minecraft sign-in code when Mojang has not approved the Azure app', async () => {
    const f = fakes({ approved: false });
    const { suite } = await createTestSuite({ oauthPost: f.oauthPost, xboxHttp: f.xboxHttp });
    const id = suite.identities.create({ label: 'Quick02' }).identity.id;
    const { result } = await signIn(suite, id);
    expect(result.minecraft).toBe('code');
    // Outlook works regardless
    expect(suite.repo.getMailAccount(result.mailboxId).kind).toBe('microsoft');
    // the classic Minecraft sign-in (test token fetcher) runs for the same account
    await settle(20);
    const mc = suite.repo.getMinecraft(id)!;
    expect(mc.msaAccount).toBe('player.one@outlook.com');
    const session = await suite.auth.getJavaSession(id);
    expect(session.accessToken).toBe('mc-token-for-player.one@outlook.com');
    await suite.shutdown();
  });
});
