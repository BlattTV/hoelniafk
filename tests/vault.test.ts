import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IsolationError, ValidationError } from '../src/core/errors.js';
import { redact } from '../src/core/logger.js';
import { PassphraseKeyProvider, StaticKeyProvider } from '../src/vault/keyProviders.js';
import { parseRef, refs } from '../src/vault/refs.js';
import { EncryptedFileVault, Vault } from '../src/vault/vault.js';
import { createTestSuite } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-vault-'));

describe('credential vault', () => {
  it('encrypts secrets at rest', async () => {
    const dir = tmp();
    const file = path.join(dir, 'vault.json');
    const v = await EncryptedFileVault.open(file, new StaticKeyProvider());
    await v.set(refs.identity(7, 'mail'), 'super-secret-imap-password');
    expect(await v.get(refs.identity(7, 'mail'))).toBe('super-secret-imap-password');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('super-secret-imap-password');
    expect(raw).toContain('vault://identity/7/mail');
  });

  it('reopens with the same key and rejects a wrong key', async () => {
    const dir = tmp();
    const file = path.join(dir, 'vault.json');
    const key = crypto.randomBytes(32);
    const v = await EncryptedFileVault.open(file, new StaticKeyProvider(key));
    await v.set(refs.app('discord-client'), 'client-secret-value');
    const again = await EncryptedFileVault.open(file, new StaticKeyProvider(key));
    expect(await again.get(refs.app('discord-client'))).toBe('client-secret-value');
    await expect(EncryptedFileVault.open(file, new StaticKeyProvider(crypto.randomBytes(32)))).rejects.toThrow(/Vault key is invalid/);
  });

  it('supports a passphrase-derived key', async () => {
    const file = path.join(tmp(), 'vault.json');
    const v = await EncryptedFileVault.open(file, new PassphraseKeyProvider('correct horse battery staple'));
    await v.set(refs.mailbox(1), 'pw');
    const again = await EncryptedFileVault.open(file, new PassphraseKeyProvider('correct horse battery staple'));
    expect(await again.get(refs.mailbox(1))).toBe('pw');
    await expect(EncryptedFileVault.open(file, new PassphraseKeyProvider('wrong passphrase!!'))).rejects.toThrow();
  });

  it('binds ciphertext to its ref (moving an entry to another identity fails)', async () => {
    const file = path.join(tmp(), 'vault.json');
    const key = crypto.randomBytes(32);
    const v = await EncryptedFileVault.open(file, new StaticKeyProvider(key));
    await v.set(refs.identity(1, 'minecraft'), 'token-of-identity-1');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.entries[refs.identity(2, 'minecraft')] = data.entries[refs.identity(1, 'minecraft')];
    fs.writeFileSync(file, JSON.stringify(data));
    const tampered = await EncryptedFileVault.open(file, new StaticKeyProvider(key));
    await expect(tampered.get(refs.identity(2, 'minecraft'))).rejects.toThrow();
  });

  it('identity-scoped access cannot reach other scopes', async () => {
    const v = new Vault(await EncryptedFileVault.open(null, new StaticKeyProvider()));
    const iv = v.forIdentity(3);
    await iv.set(iv.ref('discord'), 'x');
    await expect(iv.get(refs.identity(4, 'discord'))).rejects.toBeInstanceOf(IsolationError);
    await expect(iv.get(refs.mailbox(1))).rejects.toBeInstanceOf(IsolationError);
    await expect(iv.set(refs.app('oauth-discord'), 'y')).rejects.toBeInstanceOf(IsolationError);
    // prefix trick: identity 3 must not see identity 31
    await v.store.set(refs.identity(31, 'discord'), 'other');
    expect(await iv.list()).toEqual([refs.identity(3, 'discord')]);
  });

  it('validates refs', () => {
    expect(parseRef('vault://identity/07/mail')).toMatchObject({ kind: 'identity', identityId: 7, path: 'mail' });
    expect(() => parseRef('vault://identity/1/../2/mail')).toThrow(ValidationError);
    expect(() => parseRef('file:///etc/passwd')).toThrow(ValidationError);
  });

  it('registers secrets for log redaction when they pass through the vault', async () => {
    const v = await EncryptedFileVault.open(null, new StaticKeyProvider());
    await v.set(refs.identity(1, 'mail'), 'Hunter2-very-secret');
    expect(redact('login failed for pass Hunter2-very-secret')).not.toContain('Hunter2-very-secret');
  });
});

describe('SQLite never contains secrets', () => {
  it('stores only credential references', async () => {
    const dir = tmp();
    const { openDatabase } = await import('../src/core/db.js');
    const dbFile = path.join(dir, 'hoelni.db');
    const db = openDatabase(dbFile);
    const { suite } = await createTestSuite({ db });
    const id = suite.identities.create({ label: 'Identity07' }).identity.id;
    const box = suite.repo.createMailAccount({
      label: 'm', kind: 'imap', imapHost: 'imap.example.com', imapPort: 993, imapSecure: true, username: 'u@example.com',
      smtpHost: null, smtpPort: null, webmailUrl: null, exclusiveIdentityId: null, aliasProviderId: null,
    });
    await suite.mail.setMailboxPassword(box.id, 'IMAP-PASSWORD-123456');
    const p = suite.repo.createNetworkProfile(id, { kind: 'HTTP', proxyHost: 'proxy', proxyPort: 8080, proxyUsername: 'bob' });
    await suite.network.setProxyPassword(id, p.id, 'PROXY-PASSWORD-987654');
    suite.repo.upsertMinecraft(id, { username: 'Player07', authType: 'microsoft', msaAccount: 'acc07@example.com' });
    await suite.auth.authenticate(id);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = Buffer.concat([dbFile, `${dbFile}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f))).toString('latin1');
    for (const secret of ['IMAP-PASSWORD-123456', 'PROXY-PASSWORD-987654', 'mc-token-for-acc07']) {
      expect(bytes).not.toContain(secret);
    }
    expect(bytes).toContain('vault://identity/');
    expect(suite.repo.getMailAccount(box.id).credentialRef).toBe('vault://mailbox/' + box.id);
  });
});

describe('vault recovery', () => {
  it('restores from the newest backup when the vault file is corrupt', async () => {
    const file = path.join(tmp(), 'vault.json');
    const key = crypto.randomBytes(32);
    const v = await EncryptedFileVault.open(file, new StaticKeyProvider(key));
    await v.set(refs.identity(1, 'mail'), 'backed-up-secret');
    (v as any).lastBackupAt = 0;
    await v.set(refs.identity(1, 'discord'), 'second'); // triggers a backup of the previous state
    expect(fs.existsSync(`${file}.bak.1`)).toBe(true);
    fs.writeFileSync(file, '{ this is not json');
    const again = await EncryptedFileVault.open(file, new StaticKeyProvider(key));
    expect(await again.get(refs.identity(1, 'mail'))).toBe('backed-up-secret');
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it('does not fall back to backups with a wrong key', async () => {
    const file = path.join(tmp(), 'vault.json');
    await EncryptedFileVault.open(file, new StaticKeyProvider(crypto.randomBytes(32)));
    await expect(EncryptedFileVault.open(file, new StaticKeyProvider(crypto.randomBytes(32)))).rejects.toThrow(/Vault key is invalid/);
  });

  it('moves secrets to a new machine/key with a recovery kit', async () => {
    const file = path.join(tmp(), 'vault.json');
    const oldMachine = await EncryptedFileVault.open(file, new StaticKeyProvider(crypto.randomBytes(32)));
    await oldMachine.set(refs.identity(7, 'minecraft'), 'token-cache-07');
    await oldMachine.set(refs.mailbox(2), 'imap-pw');
    const kit = oldMachine.exportRecoveryKit('correct horse battery staple');
    expect(JSON.stringify(kit)).not.toContain('token-cache-07');
    await expect(EncryptedFileVault.recover(file, kit, 'wrong passphrase!!', new StaticKeyProvider())).rejects.toThrow(/Wrong recovery passphrase/);
    const newKey = new StaticKeyProvider(crypto.randomBytes(32));
    const n = await EncryptedFileVault.recover(file, kit, 'correct horse battery staple', newKey);
    expect(n).toBe(2);
    const onNewMachine = await EncryptedFileVault.open(file, newKey);
    expect(await onNewMachine.get(refs.identity(7, 'minecraft'))).toBe('token-cache-07');
    expect(await onNewMachine.get(refs.mailbox(2))).toBe('imap-pw');
  });
});
