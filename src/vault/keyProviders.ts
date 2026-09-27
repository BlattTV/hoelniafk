/**
 * Master-key providers for the encrypted vault.
 *
 * The vault encrypts every secret with AES-256-GCM. The 256-bit master key
 * itself is protected by the operating system:
 *   - "dpapi":    Windows DPAPI (CurrentUser scope) – the protected blob lives next to the vault
 *   - "credman":  Windows Credential Manager / macOS Keychain / Secret Service via @napi-rs/keyring
 *   - "passphrase": scrypt-derived key from HOELNI_VAULT_PASSPHRASE (headless / Linux)
 *   - "static":   fixed key, only for automated tests
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createLogger } from '../core/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('vault');

export interface KeyProvider {
  readonly name: string;
  /** Returns the 32-byte master key, creating it on first use. */
  getKey(salt: Buffer): Promise<Buffer>;
}

export class StaticKeyProvider implements KeyProvider {
  readonly name = 'static';
  constructor(private readonly key: Buffer = crypto.randomBytes(32)) {}
  async getKey(): Promise<Buffer> {
    return this.key;
  }
}

export class PassphraseKeyProvider implements KeyProvider {
  readonly name = 'passphrase';
  constructor(private readonly passphrase: string) {
    if (!passphrase || passphrase.length < 12) throw new Error('Vault passphrase must be at least 12 characters');
  }
  async getKey(salt: Buffer): Promise<Buffer> {
    return crypto.scryptSync(this.passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  }
}

/** Windows DPAPI via PowerShell (System.Security.Cryptography.ProtectedData, CurrentUser scope). */
export class DpapiKeyProvider implements KeyProvider {
  readonly name = 'dpapi';
  constructor(private readonly blobFile: string) {}

  private async ps(script: string, input: string): Promise<string> {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, HOELNI_DPAPI_IN: input }, windowsHide: true },
    );
    return stdout.trim();
  }

  async getKey(): Promise<Buffer> {
    if (process.platform !== 'win32') throw new Error('DPAPI is only available on Windows');
    const prelude = 'Add-Type -AssemblyName System.Security;';
    if (fs.existsSync(this.blobFile)) {
      const blob = fs.readFileSync(this.blobFile, 'utf8').trim();
      const out = await this.ps(
        `${prelude}[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:HOELNI_DPAPI_IN),$null,'CurrentUser'))`,
        blob,
      );
      return Buffer.from(out, 'base64');
    }
    const key = crypto.randomBytes(32);
    const out = await this.ps(
      `${prelude}[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($env:HOELNI_DPAPI_IN),$null,'CurrentUser'))`,
      key.toString('base64'),
    );
    fs.writeFileSync(this.blobFile, out, { mode: 0o600 });
    log.info('Created new DPAPI-protected vault master key');
    return key;
  }
}

/** OS credential store (Windows Credential Manager, macOS Keychain, libsecret). */
export class CredentialManagerKeyProvider implements KeyProvider {
  readonly name = 'credman';
  constructor(
    private readonly service = 'HoelniClientSuite',
    private readonly account = 'vault-master-key',
  ) {}

  static isAvailable(): boolean {
    try {
      createRequire(import.meta.url).resolve('@napi-rs/keyring');
      return true;
    } catch {
      return false;
    }
  }

  async getKey(): Promise<Buffer> {
    const req = createRequire(import.meta.url);
    const { Entry } = req('@napi-rs/keyring') as { Entry: new (s: string, a: string) => { getPassword(): string | null | undefined; setPassword(p: string): void } };
    const entry = new Entry(this.service, this.account);
    const existing = entry.getPassword();
    if (existing) return Buffer.from(existing, 'base64');
    const key = crypto.randomBytes(32);
    entry.setPassword(key.toString('base64'));
    log.info('Stored new vault master key in OS credential manager');
    return key;
  }
}

export type KeyProviderName = 'auto' | 'dpapi' | 'credman' | 'passphrase';

export function createKeyProvider(name: KeyProviderName, dpapiBlobFile: string): KeyProvider {
  const passphrase = process.env.HOELNI_VAULT_PASSPHRASE;
  switch (name) {
    case 'dpapi':
      return new DpapiKeyProvider(dpapiBlobFile);
    case 'credman':
      return new CredentialManagerKeyProvider();
    case 'passphrase':
      if (!passphrase) throw new Error('HOELNI_VAULT_PASSPHRASE is not set');
      return new PassphraseKeyProvider(passphrase);
    case 'auto':
    default:
      if (process.platform === 'win32') return new DpapiKeyProvider(dpapiBlobFile);
      if (passphrase) return new PassphraseKeyProvider(passphrase);
      if (CredentialManagerKeyProvider.isAvailable()) return new CredentialManagerKeyProvider();
      throw new Error(
        'No vault key provider available. On Windows DPAPI is used automatically; elsewhere set HOELNI_VAULT_PASSPHRASE.',
      );
  }
}
