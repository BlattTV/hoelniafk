import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerSecret } from '../core/logger.js';
import { assertIdentityRef, parseRef, refs } from './refs.js';
import type { KeyProvider } from './keyProviders.js';

export interface SecretStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<boolean>;
  /** Lists refs (never values) under a prefix. */
  list(prefix?: string): Promise<string[]>;
  /** Removes every secret under a prefix. Returns the number removed. */
  deletePrefix(prefix: string): Promise<number>;
  readonly backend: string;
}

interface VaultFile {
  version: 1;
  provider: string;
  salt: string;
  /** Encrypted check value to detect a wrong key early. */
  check: EncryptedEntry;
  entries: Record<string, EncryptedEntry>;
}

interface EncryptedEntry {
  iv: string;
  tag: string;
  ct: string;
}

const CHECK_PLAINTEXT = 'hoelni-vault-v1';

/**
 * AES-256-GCM encrypted secret store persisted as a JSON file.
 * The credential ref is used as additional authenticated data, so an entry
 * copied to another ref (e.g. another identity) fails to decrypt.
 */
export class EncryptedFileVault implements SecretStore {
  private key: Buffer | null = null;
  private data: VaultFile | null = null;

  private constructor(
    private readonly file: string | null,
    private readonly keyProvider: KeyProvider,
  ) {}

  get backend(): string {
    return `aes-256-gcm/${this.keyProvider.name}`;
  }

  /** Opens (or creates) a vault file. Pass `file = null` for an in-memory vault (tests). */
  static async open(file: string | null, keyProvider: KeyProvider): Promise<EncryptedFileVault> {
    const v = new EncryptedFileVault(file, keyProvider);
    await v.load();
    return v;
  }

  private async load(): Promise<void> {
    if (this.file && fs.existsSync(this.file)) {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as VaultFile;
      this.key = await this.keyProvider.getKey(Buffer.from(parsed.salt, 'base64'));
      try {
        const check = this.decrypt('__check__', parsed.check);
        if (check !== CHECK_PLAINTEXT) throw new Error('check mismatch');
      } catch {
        throw new Error('Vault key is invalid – cannot decrypt the credential vault');
      }
      this.data = parsed;
      return;
    }
    const salt = crypto.randomBytes(16);
    this.key = await this.keyProvider.getKey(salt);
    this.data = {
      version: 1,
      provider: this.keyProvider.name,
      salt: salt.toString('base64'),
      check: this.encrypt('__check__', CHECK_PLAINTEXT),
      entries: {},
    };
    this.persist();
  }

  private encrypt(ref: string, plaintext: string): EncryptedEntry {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key!, iv);
    cipher.setAAD(Buffer.from(ref, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  private decrypt(ref: string, e: EncryptedEntry): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key!, Buffer.from(e.iv, 'base64'));
    decipher.setAAD(Buffer.from(ref, 'utf8'));
    decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(e.ct, 'base64')), decipher.final()]).toString('utf8');
  }

  private persist(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  async get(ref: string): Promise<string | null> {
    parseRef(ref);
    const e = this.data!.entries[ref];
    if (!e) return null;
    const value = this.decrypt(ref, e);
    registerSecret(value);
    return value;
  }

  async set(ref: string, value: string): Promise<void> {
    parseRef(ref);
    registerSecret(value);
    this.data!.entries[ref] = this.encrypt(ref, value);
    this.persist();
  }

  async delete(ref: string): Promise<boolean> {
    const existed = ref in this.data!.entries;
    delete this.data!.entries[ref];
    if (existed) this.persist();
    return existed;
  }

  async list(prefix = 'vault://'): Promise<string[]> {
    return Object.keys(this.data!.entries).filter((r) => r.startsWith(prefix)).sort();
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix);
    for (const k of keys) delete this.data!.entries[k];
    if (keys.length) this.persist();
    return keys.length;
  }
}

/**
 * The only way identity-bound code reaches the vault. Every access is checked
 * against the owning identity, so identity A can never read identity B's
 * Minecraft token, Discord refresh token or proxy credentials.
 */
export class IdentityVault {
  constructor(
    private readonly store: SecretStore,
    readonly identityId: number,
  ) {}

  ref(...pathParts: Array<string | number>): string {
    return refs.identity(this.identityId, ...pathParts);
  }

  async get(ref: string): Promise<string | null> {
    assertIdentityRef(ref, this.identityId);
    return this.store.get(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    assertIdentityRef(ref, this.identityId);
    return this.store.set(ref, value);
  }

  async delete(ref: string): Promise<boolean> {
    assertIdentityRef(ref, this.identityId);
    return this.store.delete(ref);
  }

  async getJson<T>(ref: string): Promise<T | null> {
    const v = await this.get(ref);
    return v ? (JSON.parse(v) as T) : null;
  }

  async setJson(ref: string, value: unknown): Promise<void> {
    await this.set(ref, JSON.stringify(value));
  }

  async list(): Promise<string[]> {
    return this.store.list(refs.identityPrefix(this.identityId));
  }

  async purge(): Promise<number> {
    return this.store.deletePrefix(refs.identityPrefix(this.identityId));
  }
}

export class Vault {
  constructor(readonly store: SecretStore) {}

  forIdentity(identityId: number): IdentityVault {
    return new IdentityVault(this.store, identityId);
  }

  get backend(): string {
    return this.store.backend;
  }
}
