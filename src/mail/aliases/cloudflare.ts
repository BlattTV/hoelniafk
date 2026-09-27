import { SuiteError, ValidationError } from '../../core/errors.js';
import type { AliasManager, MailAlias } from '../provider.js';

export type HttpJson = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: any }>;

export const defaultHttpJson: HttpJson = async (url, init) => {
  const res = await fetch(url, init);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

/**
 * Cloudflare Email Routing (official API) for a domain you own:
 * each alias is a routing rule "to == alias → forward to destination".
 * The destination address must be verified in Cloudflare beforehand.
 *
 * Docs: https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/
 */
export class CloudflareAliasManager implements AliasManager {
  readonly kind = 'cloudflare';
  readonly canCreate = true;
  private readonly base: string;

  constructor(
    private readonly cfg: { zoneId: string; domain: string },
    private readonly apiToken: () => Promise<string>,
    private readonly http: HttpJson = defaultHttpJson,
  ) {
    if (!/^[a-f0-9]{32}$/i.test(cfg.zoneId)) throw new ValidationError('Cloudflare zone id must be 32 hex characters');
    this.base = `https://api.cloudflare.com/client/v4/zones/${cfg.zoneId}/email/routing/rules`;
  }

  private async call(method: string, path = '', body?: unknown): Promise<any> {
    const res = await this.http(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${await this.apiToken()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status >= 400 || res.json?.success === false) {
      const msg = res.json?.errors?.map((e: any) => e.message).join('; ') || `HTTP ${res.status}`;
      throw new SuiteError(`Cloudflare API error: ${msg}`, 502);
    }
    return res.json;
  }

  async listAliases(): Promise<MailAlias[]> {
    const out: MailAlias[] = [];
    for (let page = 1; page < 20; page++) {
      const json = await this.call('GET', `?page=${page}&per_page=50`);
      for (const r of json.result ?? []) {
        const to = r.matchers?.find((m: any) => m.type === 'literal' && m.field === 'to')?.value;
        const fwd = r.actions?.find((a: any) => a.type === 'forward')?.value?.[0] ?? null;
        if (to) out.push({ address: String(to).toLowerCase(), destination: fwd, enabled: !!r.enabled, providerRef: r.id ?? r.tag ?? null });
      }
      const info = json.result_info;
      if (!info || page >= Math.ceil((info.total_count ?? 0) / (info.per_page ?? 50))) break;
    }
    return out;
  }

  async createAlias(localPart: string, destination: string): Promise<MailAlias> {
    if (!/^[a-z0-9._-]{1,64}$/i.test(localPart)) throw new ValidationError('Invalid alias local part');
    const address = `${localPart.toLowerCase()}@${this.cfg.domain.toLowerCase()}`;
    const json = await this.call('POST', '', {
      name: `Hoelni alias ${address}`,
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: address }],
      actions: [{ type: 'forward', value: [destination] }],
    });
    return { address, destination, enabled: true, providerRef: json.result?.id ?? json.result?.tag ?? null };
  }

  async deleteAlias(address: string): Promise<void> {
    const alias = (await this.listAliases()).find((a) => a.address === address.toLowerCase());
    if (!alias?.providerRef) throw new SuiteError(`Alias ${address} not found at Cloudflare`, 404);
    await this.call('DELETE', `/${alias.providerRef}`);
  }
}
