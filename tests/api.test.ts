import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/web/server.js';
import { createTestSuite } from './helpers.js';

async function setup() {
  const t = await createTestSuite();
  const { app, apiToken } = await buildServer(t.suite, { apiToken: 'test-token-123' });
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload: payload as any, headers: { host: '127.0.0.1:7420', 'x-hoelni-token': apiToken, ...headers } });
  return { ...t, app, call };
}

describe('web API security', () => {
  it('requires the per-launch API token', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: '127.0.0.1:7420' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects foreign Host headers (DNS rebinding) and cross-origin requests', async () => {
    const { call } = await setup();
    expect((await call('GET', '/api/dashboard', undefined, { host: 'evil.example:7420' })).statusCode).toBe(421);
    expect((await call('POST', '/api/identities', {}, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await call('POST', '/api/identities', {}, { origin: 'http://127.0.0.1:7420' })).statusCode).toBe(200);
  });

  it('sends a strict CSP and embeds the token only into the UI page', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: '127.0.0.1:7420' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.body).toContain('test-token-123');
  });

  it('never returns secret values', async () => {
    const { call } = await setup();
    const id = (await call('POST', '/api/identities', { label: 'Identity01' })).json().identity.id;
    const box = (await call('POST', '/api/mailboxes', { kind: 'imap', imapHost: 'imap.example.com', username: 'u@example.com', password: 'IMAP-SECRET-XYZ' })).json();
    expect(box.hasCredentials).toBe(true);
    await call('PUT', `/api/identities/${id}/mail`, { mailAccountId: box.id, address: 'u@example.com' });
    const n = (await call('POST', `/api/identities/${id}/network`, { kind: 'SOCKS5', proxyHost: 'p', proxyPort: 1080, proxyUsername: 'x', password: 'PROXY-SECRET-XYZ' })).json();
    expect(n.credentialRef).toBe(`vault://identity/${id}/network/${n.id}`);
    const bodies = [
      (await call('GET', `/api/identities/${id}`)).body,
      (await call('GET', '/api/mailboxes')).body,
      (await call('GET', '/api/vault')).body,
      (await call('GET', '/api/audit')).body,
      (await call('GET', '/api/settings')).body,
    ].join('\n');
    expect(bodies).not.toContain('IMAP-SECRET-XYZ');
    expect(bodies).not.toContain('PROXY-SECRET-XYZ');
    expect(bodies).toContain(`vault://identity/${id}/network/${n.id}`);
  });

  it('maps isolation violations to 403', async () => {
    const { call } = await setup();
    const a = (await call('POST', '/api/identities', {})).json().identity.id;
    const b = (await call('POST', '/api/identities', {})).json().identity.id;
    const pb = (await call('POST', `/api/identities/${b}/network`, { kind: 'BIND', localBindIp: '10.0.0.2' })).json();
    const res = await call('PATCH', `/api/identities/${a}`, { networkProfileId: pb.id });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe('IsolationError');
  });

  it('completes the Discord OAuth callback for the identity that started it', async () => {
    const { call, app, suite } = await setup();
    const id = (await call('POST', '/api/identities', {})).json().identity.id;
    const { url } = (await call('POST', `/api/identities/${id}/discord/connect`)).json();
    const u = new URL(url);
    expect(u.origin).toBe('https://discord.com');
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:7420/oauth/callback');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    const cb = await app.inject({ method: 'GET', url: `/oauth/callback?code=code-5&state=${u.searchParams.get('state')}`, headers: { host: '127.0.0.1:7420' } });
    expect(cb.body).toContain('Discord connected');
    expect(suite.repo.getDiscord(id)).toMatchObject({ oauthState: 'CONNECTED', username: 'discorduser5' });
    const bad = await app.inject({ method: 'GET', url: '/oauth/callback?code=x&state=forged', headers: { host: '127.0.0.1:7420' } });
    expect(bad.body).toContain('Connection failed');
  });

  it('the Create-Discord-Account workflow only opens the official sign-up page', async () => {
    const { call } = await setup();
    const id = (await call('POST', '/api/identities', {})).json().identity.id;
    expect((await call('POST', `/api/identities/${id}/discord/signup`)).json()).toEqual({ url: 'https://discord.com/register' });
  });

  it('runs bulk operations and returns per-identity results', async () => {
    const { call } = await setup();
    const a = (await call('POST', '/api/identities', {})).json().identity.id;
    const res = (await call('POST', '/api/bulk', { action: 'openDiscord', identityIds: [a] })).json();
    expect(res.results[0]).toMatchObject({ identityId: a, ok: true, url: 'https://discord.com/app' });
    expect((await call('POST', '/api/bulk', { action: 'rm -rf', identityIds: [a] })).statusCode).toBe(400);
  });
});
