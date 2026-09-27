import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger, registerSecret } from '../core/logger.js';
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
const BACKUPS = 3;
const BACKUP_INTERVAL_MS = 10 * 60_000;
const log = createLogger('vault');

/**
 * Recovery kit: the vault master key encrypted with a user passphrase (scrypt +
 * AES-256-GCM). Needed when the DPAPI/Credential-Manager protected key is lost,
 * e.g. after moving to a new PC or Windows user.
 */
export interface RecoveryKit {
  kind: 'hoelni-vault-recovery';
  version: 1;
  created: string;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

function kitKey(passphrase: string, salt: Buffer): Buffer {
  if (!passphrase || passphrase.length < 12) throw new Error('Recovery passphrase must be at least 12 characters');
  return crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/**
 * AES-256-GCM encrypted secret store persisted as a JSON file.
 * The credential ref is used as additional authenticated data, so an entry
 * copied to another ref (e.g. another identity) fails to decrypt.
 */
export class EncryptedFileVault implements SecretStore {
  private key: Buffer | null = null;
  private data: VaultFile | null = null;
  private lastBackupAt = 0;

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

  /** Reads the vault file; falls back to the newest readable backup if the file is corrupt. */
  private readFileWithFallback(): VaultFile {
    const candidates = [this.file!, ...Array.from({ length: BACKUPS }, (_, i) => `${this.file}.bak.${i + 1}`)];
    for (const f of candidates) {
      if (!fs.existsSync(f)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(f, 'utf8')) as VaultFile;
        if (parsed?.version !== 1 || !parsed.check || !parsed.entries || !parsed.salt) throw new Error('invalid structure');
        if (f !== this.file) {
          log.warn(`Vault file was corrupt – restored from backup ${path.basename(f)}`);
          fs.copyFileSync(this.file!, `${this.file}.corrupt-${Date.now()}`);
          fs.copyFileSync(f, this.file!);
        }
        return parsed;
      } catch (e) {
        log.warn(`Vault file ${path.basename(f)} unreadable: ${(e as Error).message}`);
      }
    }
    throw new Error('Vault file and all backups are unreadable');
  }

  private async load(): Promise<void> {
    if (this.file && fs.existsSync(this.file)) {
      const parsed = this.readFileWithFallback();
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
    this.rotateBackups();
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(this.data, null, 1));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  /** Keeps up to 3 rotating copies (at most one new copy every 10 minutes). */
  private rotateBackups(force = false): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    if (!force && Date.now() - this.lastBackupAt < BACKUP_INTERVAL_MS) return;
    for (let i = BACKUPS - 1; i >= 1; i--) {
      const from = `${this.file}.bak.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.bak.${i + 1}`);
    }
    fs.copyFileSync(this.file, `${this.file}.bak.1`);
    this.lastBackupAt = Date.now();
  }

  /** Exports the master key protected by a passphrase. Store the kit offline. */
  exportRecoveryKit(passphrase: string): RecoveryKit {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kitKey(passphrase, salt), iv);
    cipher.setAAD(Buffer.from('hoelni-vault-recovery'));
    const ct = Buffer.concat([cipher.update(this.key!), cipher.final()]);
    return {
      kind: 'hoelni-vault-recovery',
      version: 1,
      created: new Date().toISOString(),
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    };
  }

  /** Decrypts the master key of a recovery kit. */
  static keyFromRecoveryKit(kit: RecoveryKit, passphrase: string): Buffer {
    if (kit?.kind !== 'hoelni-vault-recovery') throw new Error('Not a Hoelni vault recovery kit');
    const decipher = crypto.createDecipheriv('aes-256-gcm', kitKey(passphrase, Buffer.from(kit.salt, 'base64')), Buffer.from(kit.iv, 'base64'));
    decipher.setAAD(Buffer.from('hoelni-vault-recovery'));
    decipher.setAuthTag(Buffer.from(kit.tag, 'base64'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(kit.ct, 'base64')), decipher.final()]);
    } catch {
      throw new Error('Wrong recovery passphrase or damaged kit');
    }
  }

  /**
   * Re-encrypts an existing vault file under a new key provider using a recovery
   * kit (new PC / new Windows user / lost DPAPI key). The old file is kept.
   */
  static async recover(file: string, kit: RecoveryKit, passphrase: string, newProvider: KeyProvider): Promise<number> {
    const key = EncryptedFileVault.keyFromRecoveryKit(kit, passphrase);
    const { StaticKeyProvider } = await import('./keyProviders.js');
    const old = await EncryptedFileVault.open(file, new StaticKeyProvider(key));
    const refsList = await old.list();
    const values = new Map<string, string>();
    for (const r of refsList) values.set(r, (await old.get(r))!);
    const moved = `${file}.pre-recovery-${Date.now()}`;
    fs.renameSync(file, moved);
    const fresh = await EncryptedFileVault.open(file, newProvider);
    for (const [r, v] of values) await fresh.set(r, v);
    log.info(`Vault recovered: ${values.size} secret(s) re-encrypted with ${newProvider.name}; old file kept as ${path.basename(moved)}`);
    return values.size;
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
