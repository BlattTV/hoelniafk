import { describe, expect, it } from 'vitest';
import { CloudflareAliasManager } from '../src/mail/aliases/cloudflare.js';
import { PlusAddressingAliasManager } from '../src/mail/aliases/plusAddressing.js';

describe('alias providers', () => {
  it('Cloudflare Email Routing: creates literal "to" → forward rules and deletes by rule id', async () => {
    const calls: Array<{ url: string; method: string; body?: any; auth: string }> = [];
    const rules: any[] = [];
    const http = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
      if (init.method === 'POST') {
        const r = { id: `rule${rules.length + 1}`, ...JSON.parse(init.body!) };
        rules.push(r);
        return { status: 200, json: { success: true, result: r } };
      }
      if (init.method === 'DELETE') {
        const id = url.split('/').pop();
        rules.splice(rules.findIndex((r) => r.id === id), 1);
        return { status: 200, json: { success: true, result: {} } };
      }
      return { status: 200, json: { success: true, result: rules, result_info: { total_count: rules.length, per_page: 50 } } };
    };
    const zone = 'a'.repeat(32);
    const m = new CloudflareAliasManager({ zoneId: zone, domain: 'hoelni.example' }, async () => 'cf-token', http);
    const alias = await m.createAlias('MC07', 'real@example.com');
    expect(alias.address).toBe('mc07@hoelni.example');
    expect(calls[0]).toMatchObject({
      url: `https://api.cloudflare.com/client/v4/zones/${zone}/email/routing/rules`,
      method: 'POST',
      auth: 'Bearer cf-token',
      body: { enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'mc07@hoelni.example' }], actions: [{ type: 'forward', value: ['real@example.com'] }] },
    });
    expect((await m.listAliases()).map((a) => a.address)).toEqual(['mc07@hoelni.example']);
    await m.deleteAlias('mc07@hoelni.example');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: expect.stringMatching(/\/rules\/rule1$/) });
    await expect(m.createAlias('bad local part!', 'x@y.z')).rejects.toThrow();
  });

  it('surfaces Cloudflare API errors', async () => {
    const m = new CloudflareAliasManager({ zoneId: 'b'.repeat(32), domain: 'x.example' }, async () => 't', async () => ({ status: 403, json: { success: false, errors: [{ message: 'Authentication error' }] } }));
    await expect(m.listAliases()).rejects.toThrow(/Authentication error/);
  });

  it('plus addressing derives aliases without any API call', async () => {
    const m = new PlusAddressingAliasManager('afk@example.com', () => ['afk+mc01@example.com', 'other@example.com']);
    expect((await m.createAlias('MC02')).address).toBe('afk+mc02@example.com');
    expect((await m.listAliases()).map((a) => a.address)).toEqual(['afk+mc01@example.com']);
  });
});
