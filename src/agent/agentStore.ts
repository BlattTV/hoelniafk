/**
 * Settings and sign-in of an agent (shared by the command line agent and the Android app).
 *
 *   <dataDir>/agent.json        backend address, device id, name, pinned certificate …
 *   <dataDir>/agent-vault.json  device token and proxy URL, encrypted (DPAPI on Windows, a key from
 *                               the Android keystore on Android) – in agent.json only without a key
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appRoot, currentBuild } from '../ops/updater.js';
import { DEFAULT_BACKEND, normalizeBackendUrl, probeCertificate, requestJson, type TransportOptions } from './transport.js';
import { createKeyProvider } from '../vault/keyProviders.js';
import { refs } from '../vault/refs.js';
import { EncryptedFileVault, type SecretStore } from '../vault/vault.js';

export interface Stored {
  backendUrl: string;
  /** Only when no OS key protection is available (e.g. Linux without keyring) – file mode 0600. */
  token?: string;
  tokenInVault?: boolean;
  deviceId?: number;
  username?: string;
  name?: string;
  pinnedCert?: string | null;
  /** Only without OS key protection; otherwise the proxy URL (may contain a password) is in the vault. */
  proxy?: string | null;
  proxyInVault?: boolean;
  /** Update signing key of the backend (pinned on first contact, reset on a new sign-in). */
  updatesKey?: string;
}

/** Error with details for the caller (e.g. the certificate to confirm). */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly code = 1,
  ) {
    super(message);
  }
}

const TOKEN_REF = refs.app('agent-token');
const PROXY_REF = refs.app('agent-proxy');

export function agentVersion(): string {
  const b = currentBuild(appRoot());
  return b.build ? `${b.version} (build ${b.build})` : b.version;
}

export class AgentStore {
  readonly file: string;

  constructor(readonly dataDir: string) {
    this.file = path.join(dataDir, 'agent.json');
  }

  load(): Stored {
    try {
      return { backendUrl: DEFAULT_BACKEND, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      return { backendUrl: DEFAULT_BACKEND };
    }
  }

  save(s: Stored): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  async vault(): Promise<SecretStore | null> {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      return await EncryptedFileVault.open(path.join(this.dataDir, 'agent-vault.json'), createKeyProvider('auto', path.join(this.dataDir, 'agent-key.dpapi')));
    } catch {
      return null;
    }
  }

  async storeToken(s: Stored, token: string): Promise<Stored> {
    const v = await this.vault();
    if (v) {
      await v.set(TOKEN_REF, token);
      return { ...s, token: undefined, tokenInVault: true };
    }
    return { ...s, token, tokenInVault: false };
  }

  async readToken(s: Stored): Promise<string | null> {
    if (!s.tokenInVault) return s.token ?? null;
    return (await (await this.vault())?.get(TOKEN_REF)) ?? null;
  }

  async forgetToken(s: Stored): Promise<void> {
    if (s.tokenInVault) await (await this.vault())?.delete(TOKEN_REF);
  }

  signedIn(s: Stored): boolean {
    return !!(s.tokenInVault || s.token) && !!s.deviceId;
  }

  async readProxy(s: Stored): Promise<string | null> {
    if (!s.proxyInVault) return s.proxy ?? null;
    return (await (await this.vault())?.get(PROXY_REF)) ?? null;
  }

  async setProxy(proxy: string): Promise<string> {
    if (proxy && !/^(https?|socks5h?):\/\//i.test(proxy)) throw new AgentError('proxy must look like http://host:port or socks5://user:pass@host:port');
    const v = await this.vault();
    if (v) {
      if (proxy) await v.set(PROXY_REF, proxy);
      else await v.delete(PROXY_REF);
      this.save({ ...this.load(), proxy: null, proxyInVault: !!proxy });
    } else this.save({ ...this.load(), proxy: proxy || null, proxyInVault: false });
    return proxy.replace(/\/\/([^:@/]*):[^@/]*@/, '//$1:•••@');
  }

  proxyFields(s: Stored): Pick<Stored, 'proxy' | 'proxyInVault'> {
    return { proxy: s.proxy ?? null, proxyInVault: !!s.proxyInVault };
  }

  async transport(s: Stored): Promise<TransportOptions> {
    return { pinnedCert: s.pinnedCert ?? null, proxy: await this.readProxy(s) };
  }

  /**
   * Signs this device in. A backend with a certificate that is not publicly trusted needs the
   * fingerprint confirmed once (trustCert) – otherwise AgentError with { needsTrust, fingerprint } (code 4).
   */
  async login(input: { user: string; password: string; name?: string; trustCert?: string; backend?: string }): Promise<{ username: string; backendUrl: string }> {
    const s = this.load();
    if (input.backend) s.backendUrl = normalizeBackendUrl(input.backend);
    if (!input.user || !input.password) throw new AgentError('usage: login --user NAME --password PW [--name NAME] [--trust-cert FINGERPRINT]');
    if (!s.pinnedCert) {
      let cert: Awaited<ReturnType<typeof probeCertificate>>;
      try {
        cert = await probeCertificate(s.backendUrl, { proxy: await this.readProxy(s) });
      } catch (e) {
        throw new AgentError(`Backend not reachable: ${(e as Error).message}`);
      }
      if (cert && !cert.trusted) {
        const info = { needsTrust: true, fingerprint: cert.fingerprint256, subject: cert.subject };
        if (!input.trustCert) throw new AgentError('The backend uses a certificate that is not publicly trusted – compare the fingerprint and confirm', info, 4);
        if (input.trustCert.toUpperCase() !== cert.fingerprint256.toUpperCase()) throw new AgentError('The backend certificate changed since you confirmed it – check again', info, 4);
        s.pinnedCert = cert.pem;
      }
    }
    const name = input.name || os.hostname();
    let r: { token: string; deviceId: number; user: { username: string } };
    try {
      r = await requestJson(
        `${s.backendUrl}/api/login`,
        'POST',
        { username: input.user, password: input.password, client: 'agent', name, info: { hostname: os.hostname(), os: `${os.platform()} ${os.release()}`, version: agentVersion() } },
        await this.transport(s),
      );
    } catch (e) {
      throw new AgentError((e as Error).message);
    }
    await this.forgetToken(s);
    this.save(await this.storeToken({ ...s, deviceId: r.deviceId, username: r.user.username, name, updatesKey: undefined }, r.token));
    return { username: r.user.username, backendUrl: s.backendUrl };
  }

  async logout(): Promise<void> {
    const s = this.load();
    const token = await this.readToken(s);
    if (token) await requestJson(`${s.backendUrl}/api/logout`, 'POST', {}, await this.transport(s), { Authorization: `Bearer ${token}` }).catch(() => undefined);
    await this.forgetToken(s);
    this.save({ backendUrl: s.backendUrl, ...this.proxyFields(s), pinnedCert: s.pinnedCert ?? null });
  }

  async changeBackend(target: string, adminUser: string, adminPassword: string): Promise<string> {
    const s = this.load();
    await requestJson(`${s.backendUrl}/api/verify-admin`, 'POST', { username: adminUser, password: adminPassword }, await this.transport(s)).catch((e) => {
      throw new AgentError(`The current backend (${s.backendUrl}) did not confirm the admin account: ${(e as Error).message}`);
    });
    const url = normalizeBackendUrl(target);
    const token = await this.readToken(s);
    if (token) await requestJson(`${s.backendUrl}/api/logout`, 'POST', {}, await this.transport(s), { Authorization: `Bearer ${token}` }).catch(() => undefined);
    await this.forgetToken(s);
    this.save({ backendUrl: url, ...this.proxyFields(s), pinnedCert: null });
    return url;
  }
}
