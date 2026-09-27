import nodemailer from 'nodemailer';
import type { AuditLog } from '../core/audit.js';
import { maskCode } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { IsolationError, NotFoundError, ValidationError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { OAuthManager, OAuthProviderName, TokenSet } from '../core/oauth.js';
import { classifyMail, extractCodes, type MailCategory, type RulesConfig } from '../core/rules.js';
import type { MailAccount, MailIdentity } from '../core/types.js';
import type { IdentityRepository } from '../identity/repository.js';
import { refs } from '../vault/refs.js';
import type { Vault } from '../vault/vault.js';
import { CloudflareAliasManager, type HttpJson, defaultHttpJson } from './aliases/cloudflare.js';
import { PlusAddressingAliasManager } from './aliases/plusAddressing.js';
import { ImapMessageSource, type ImapAuth } from './imapSource.js';
import { parseMessage, type ParsedMessage } from './parse.js';
import { composeProvider, type AliasManager, type MailAlias, type MailProvider, type MessageSource } from './provider.js';

const log = createLogger('mail');

export type MailboxSecret =
  | { type: 'password'; password: string }
  | { type: 'oauth'; provider: OAuthProviderName; refreshToken: string };

export interface StoredMessage {
  id: number;
  mailAccountId: number;
  uid: number;
  messageId: string | null;
  from: string | null;
  fromName: string | null;
  to: string[];
  subject: string;
  date: string | null;
  seen: boolean;
  hasAttachments: boolean;
  identityId: number | null;
  identityLabel?: string | null;
  identityNumber?: number | null;
  manualAssignment: boolean;
  provider: string | null;
  category: MailCategory | null;
}

export interface MessageFilter {
  q?: string;
  sender?: string;
  subject?: string;
  unread?: boolean;
  category?: MailCategory | 'verification-any';
  provider?: string;
  identityId?: number;
  limit?: number;
}

export interface MessageDetail extends StoredMessage {
  text: string;
  html: string | null;
  links: ParsedMessage['links'];
  attachments: ParsedMessage['attachments'];
  /** Verification / security codes found by the matching rule. Shown in UI, never logged. */
  codes: string[];
}

export interface AliasProviderRecord {
  id: number;
  kind: 'plus' | 'cloudflare';
  label: string;
  config: Record<string, string>;
  credentialRef: string | null;
}

export type SourceFactory = (account: MailAccount, auth: () => Promise<ImapAuth>) => MessageSource;

const defaultSourceFactory: SourceFactory = (account, auth) =>
  new ImapMessageSource({ host: account.imapHost, port: account.imapPort, secure: account.imapSecure, auth });

const WEBMAIL: Record<string, string> = {
  microsoft: 'https://outlook.live.com/mail/0/',
  google: 'https://mail.google.com/mail/u/0/#inbox',
};

type Row = Record<string, any>;

function mapMessage(r: Row): StoredMessage {
  return {
    id: r.id,
    mailAccountId: r.mail_account_id,
    uid: r.uid,
    messageId: r.message_id,
    from: r.from_addr,
    fromName: r.from_name,
    to: JSON.parse(r.to_json),
    subject: r.subject ?? '',
    date: r.date,
    seen: r.seen === 1,
    hasAttachments: r.has_attachments === 1,
    identityId: r.identity_id,
    identityLabel: r.identity_label,
    identityNumber: r.identity_number,
    manualAssignment: r.manual_assignment === 1,
    provider: r.provider_tag,
    category: r.category,
  };
}

export class MailService {
  syncLimit = 100;
  private readonly accessTokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly oauth: OAuthManager,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly getRules: () => RulesConfig,
    private readonly sourceFactory: SourceFactory = defaultSourceFactory,
    private readonly http: HttpJson = defaultHttpJson,
  ) {}

  private get db() {
    return this.repo.db;
  }

  // ------------------------------------------------------------ mailbox credentials

  async setMailboxPassword(mailboxId: number, password: string): Promise<MailAccount> {
    this.repo.getMailAccount(mailboxId);
    if (!password) throw new ValidationError('Password must not be empty');
    const ref = refs.mailbox(mailboxId);
    await this.vault.store.set(ref, JSON.stringify({ type: 'password', password } satisfies MailboxSecret));
    this.accessTokens.delete(mailboxId);
    this.audit.record(null, 'Mailbox credentials updated', { mailbox: mailboxId });
    return this.repo.updateMailAccount(mailboxId, { credentialRef: ref });
  }

  async storeMailboxOAuth(mailboxId: number, provider: OAuthProviderName, tokens: TokenSet): Promise<MailAccount> {
    this.repo.getMailAccount(mailboxId);
    if (!tokens.refreshToken) throw new ValidationError('Provider returned no refresh token');
    const ref = refs.mailbox(mailboxId);
    await this.vault.store.set(ref, JSON.stringify({ type: 'oauth', provider, refreshToken: tokens.refreshToken } satisfies MailboxSecret));
    this.accessTokens.set(mailboxId, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    this.audit.record(null, 'Mailbox OAuth connected', { mailbox: mailboxId, provider });
    return this.repo.updateMailAccount(mailboxId, { credentialRef: ref });
  }

  private async authFor(account: MailAccount): Promise<ImapAuth> {
    if (!account.credentialRef) throw new ValidationError(`Mailbox ${account.label} has no credentials`);
    if (account.credentialRef !== refs.mailbox(account.id)) throw new IsolationError('Mailbox credential reference mismatch');
    const raw = await this.vault.store.get(account.credentialRef);
    if (!raw) throw new ValidationError(`Credentials for mailbox ${account.label} are missing in the vault`);
    const secret = JSON.parse(raw) as MailboxSecret;
    if (secret.type === 'password') return { user: account.username, pass: secret.password };
    const cached = this.accessTokens.get(account.id);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return { user: account.username, accessToken: cached.token };
    const tokens = await this.oauth.refresh(secret.provider, secret.refreshToken);
    if (tokens.refreshToken && tokens.refreshToken !== secret.refreshToken) {
      await this.vault.store.set(account.credentialRef, JSON.stringify({ ...secret, refreshToken: tokens.refreshToken }));
    }
    this.accessTokens.set(account.id, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    return { user: account.username, accessToken: tokens.accessToken };
  }

  private sourceFor(account: MailAccount): MessageSource {
    return this.sourceFactory(account, () => this.authFor(account));
  }

  providerFor(mailboxId: number): MailProvider {
    const account = this.repo.getMailAccount(mailboxId);
    return composeProvider(this.sourceFor(account), this.aliasManagerFor(account));
  }

  webmailUrl(account: MailAccount): string | null {
    return account.webmailUrl || WEBMAIL[account.kind] || null;
  }

  // ------------------------------------------------------------ identity ↔ mailbox (isolation core)

  /** Returns the identity's mail assignment and mailbox. The only entry point for identity-scoped mail access. */
  mailboxForIdentity(identityId: number): { account: MailAccount; mail: MailIdentity } {
    const mail = this.repo.getMailIdentity(identityId);
    if (!mail) throw new ValidationError('No mailbox assigned to this identity');
    const account = this.repo.getMailAccount(mail.mailAccountId);
    if (account.exclusiveIdentityId !== null && account.exclusiveIdentityId !== identityId) {
      throw new IsolationError('Mailbox is exclusive to another identity');
    }
    return { account, mail };
  }

  /** Decides which identity a message on a mailbox belongs to (by recipient address). */
  resolveRecipient(account: MailAccount, to: string[]): number | null {
    const identities = this.repo.listMailIdentitiesForAccount(account.id);
    const recipients = new Set(to.map((t) => t.toLowerCase()));
    const matches = identities.filter((m) => recipients.has(m.address.toLowerCase()));
    if (matches.length === 1) return matches[0].identityId;
    if (matches.length > 1) return null; // ambiguous: never guess between identities
    if (account.exclusiveIdentityId !== null) return account.exclusiveIdentityId;
    if (identities.length === 1 && recipients.has(account.username.toLowerCase())) return identities[0].identityId;
    return null;
  }

  // ------------------------------------------------------------ sync

  async syncMailbox(mailboxId: number): Promise<{ fetched: number }> {
    const account = this.repo.getMailAccount(mailboxId);
    const headers = await this.sourceFor(account).listMessages({ limit: this.syncLimit });
    const rules = this.getRules();
    const upsert = this.db.prepare(
      `INSERT INTO mail_messages (mail_account_id, uid, message_id, from_addr, from_name, to_json, subject, date, seen, has_attachments,
         identity_id, provider_tag, category)
       VALUES (@account, @uid, @messageId, @from, @fromName, @to, @subject, @date, @seen, @att, @identity, @provider, @category)
       ON CONFLICT(mail_account_id, uid) DO UPDATE SET seen=excluded.seen, provider_tag=excluded.provider_tag, category=excluded.category,
         identity_id = CASE WHEN mail_messages.manual_assignment = 1 THEN mail_messages.identity_id ELSE excluded.identity_id END`,
    );
    this.db.transaction(() => {
      for (const h of headers) {
        const cls = classifyMail(rules, { from: h.from?.address ?? '', subject: h.subject });
        upsert.run({
          account: account.id,
          uid: h.uid,
          messageId: h.messageId,
          from: h.from?.address ?? null,
          fromName: h.from?.name ?? null,
          to: JSON.stringify(h.to),
          subject: h.subject,
          date: h.date,
          seen: h.seen ? 1 : 0,
          att: h.hasAttachments ? 1 : 0,
          identity: this.resolveRecipient(account, h.to),
          provider: cls?.provider ?? null,
          category: cls?.category ?? null,
        });
      }
      if (headers.length) {
        const minUid = Math.min(...headers.map((h) => h.uid));
        const uids = headers.map((h) => h.uid);
        // Drop cached headers of messages that were deleted on the server.
        this.db
          .prepare(`DELETE FROM mail_messages WHERE mail_account_id = ? AND uid >= ? AND uid NOT IN (${uids.map(() => '?').join(',')})`)
          .run(account.id, minUid, ...uids);
      }
    })();
    for (const m of this.repo.listMailIdentitiesForAccount(account.id)) {
      const unread = (this.db.prepare('SELECT COUNT(*) AS c FROM mail_messages WHERE identity_id = ? AND mail_account_id = ? AND seen = 0').get(m.identityId, account.id) as Row).c;
      this.repo.updateMailStatus(m.identityId, { accessStatus: 'OK', unreadCount: unread });
      this.bus.emit({ type: 'mail.updated', identityId: m.identityId, data: { unread } });
    }
    return { fetched: headers.length };
  }

  /** "Check mail" for one identity: syncs its mailbox and updates access status / unread count. */
  async checkIdentity(identityId: number): Promise<MailIdentity> {
    const { account } = this.mailboxForIdentity(identityId);
    try {
      await this.syncMailbox(account.id);
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      log.warn(`Mail check failed for identity ${identityId}: ${msg}`);
      for (const m of this.repo.listMailIdentitiesForAccount(account.id)) {
        this.repo.updateMailStatus(m.identityId, { accessStatus: 'ERROR', lastError: msg });
      }
    }
    this.bus.emit({ type: 'identity.changed', identityId });
    return this.repo.getMailIdentity(identityId)!;
  }

  // ------------------------------------------------------------ listing

  private query(where: string[], params: unknown[], f: MessageFilter): StoredMessage[] {
    if (f.q) {
      where.push('(m.subject LIKE ? OR m.from_addr LIKE ? OR m.from_name LIKE ?)');
      const q = `%${f.q}%`;
      params.push(q, q, q);
    }
    if (f.sender) {
      where.push('(m.from_addr LIKE ? OR m.from_name LIKE ?)');
      params.push(`%${f.sender}%`, `%${f.sender}%`);
    }
    if (f.subject) {
      where.push('m.subject LIKE ?');
      params.push(`%${f.subject}%`);
    }
    if (f.unread) where.push('m.seen = 0');
    if (f.category === 'verification-any') where.push("m.category IN ('verification','security','account')");
    else if (f.category) {
      where.push('m.category = ?');
      params.push(f.category);
    }
    if (f.provider) {
      where.push('m.provider_tag = ?');
      params.push(f.provider);
    }
    const sql = `SELECT m.*, i.label AS identity_label, i.number AS identity_number FROM mail_messages m
      LEFT JOIN identities i ON i.id = m.identity_id
      WHERE ${where.length ? where.join(' AND ') : '1=1'} ORDER BY m.date DESC, m.uid DESC LIMIT ?`;
    params.push(Math.min(f.limit ?? 200, 1000));
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapMessage);
  }

  /** Messages of one identity – only those on its own mailbox addressed/assigned to it. */
  listForIdentity(identityId: number, f: MessageFilter = {}): StoredMessage[] {
    const { account } = this.mailboxForIdentity(identityId);
    return this.query(['m.identity_id = ?', 'm.mail_account_id = ?'], [identityId, account.id], f);
  }

  /** ALL MAIL: messages of all identities (admin view). */
  globalInbox(f: MessageFilter = {}): StoredMessage[] {
    const where = ['m.identity_id IS NOT NULL'];
    const params: unknown[] = [];
    if (f.identityId !== undefined) {
      where.push('m.identity_id = ?');
      params.push(f.identityId);
    }
    return this.query(where, params, f);
  }

  /** Messages on a mailbox not yet assigned to any identity. */
  unassigned(mailboxId: number, f: MessageFilter = {}): StoredMessage[] {
    return this.query(['m.mail_account_id = ?', 'm.identity_id IS NULL'], [mailboxId], f);
  }

  private getRow(messageId: number): StoredMessage {
    const r = this.db
      .prepare('SELECT m.*, i.label AS identity_label, i.number AS identity_number FROM mail_messages m LEFT JOIN identities i ON i.id = m.identity_id WHERE m.id = ?')
      .get(messageId) as Row | undefined;
    if (!r) throw new NotFoundError(`Message ${messageId} not found`);
    return mapMessage(r);
  }

  /** Throws unless the message belongs to the identity and lives on the identity's mailbox. */
  private assertMessageOwned(identityId: number, msg: StoredMessage): MailAccount {
    const { account } = this.mailboxForIdentity(identityId);
    if (msg.identityId !== identityId || msg.mailAccountId !== account.id) {
      throw new IsolationError(`Message ${msg.id} does not belong to identity ${identityId}`);
    }
    return account;
  }

  async getMessage(identityId: number, messageId: number, opts: { markSeen?: boolean } = {}): Promise<MessageDetail> {
    const row = this.getRow(messageId);
    const account = this.assertMessageOwned(identityId, row);
    return this.loadDetail(account, row, opts.markSeen ?? true);
  }

  /** Mailbox-level access (for unassigned messages in the mailbox manager). */
  async getMailboxMessage(mailboxId: number, messageId: number): Promise<MessageDetail> {
    const row = this.getRow(messageId);
    if (row.mailAccountId !== mailboxId) throw new IsolationError('Message is not on this mailbox');
    if (row.identityId !== null) return this.getMessage(row.identityId, messageId);
    return this.loadDetail(this.repo.getMailAccount(mailboxId), row, false);
  }

  private async loadDetail(account: MailAccount, row: StoredMessage, markSeen: boolean): Promise<MessageDetail> {
    const source = this.sourceFor(account);
    const raw = await source.getMessage(row.uid);
    const parsed = await parseMessage(raw.source);
    const rules = this.getRules();
    const cls = classifyMail(rules, { from: parsed.from, subject: parsed.subject, text: parsed.text });
    const codes = cls && ['verification', 'security', 'account'].includes(cls.category) ? extractCodes(rules, cls.ruleId, parsed.subject, parsed.text) : [];
    if (cls && (cls.provider !== row.provider || cls.category !== row.category)) {
      this.db.prepare('UPDATE mail_messages SET provider_tag = ?, category = ? WHERE id = ?').run(cls.provider, cls.category, row.id);
    }
    if (markSeen && !row.seen) {
      await source.setSeen(row.uid, true).catch(() => undefined);
      this.db.prepare('UPDATE mail_messages SET seen = 1 WHERE id = ?').run(row.id);
      if (row.identityId) this.refreshUnread(row.identityId);
    }
    return {
      ...row,
      seen: markSeen ? true : row.seen,
      provider: cls?.provider ?? row.provider,
      category: cls?.category ?? row.category,
      text: parsed.text,
      html: parsed.html,
      links: parsed.links,
      attachments: parsed.attachments,
      codes,
    };
  }

  async getAttachment(identityId: number, messageId: number, index: number): Promise<{ filename: string; contentType: string; content: Buffer }> {
    const row = this.getRow(messageId);
    const account = this.assertMessageOwned(identityId, row);
    const raw = await this.sourceFor(account).getMessage(row.uid);
    const parsed = await parseMessage(raw.source);
    const meta = parsed.attachments[index];
    if (!meta) throw new NotFoundError('Attachment not found');
    return { filename: meta.filename, contentType: meta.contentType, content: parsed.rawAttachments[index].content };
  }

  async setSeen(identityId: number, messageId: number, seen: boolean): Promise<void> {
    const row = this.getRow(messageId);
    const account = this.assertMessageOwned(identityId, row);
    await this.sourceFor(account).setSeen(row.uid, seen);
    this.db.prepare('UPDATE mail_messages SET seen = ? WHERE id = ?').run(seen ? 1 : 0, messageId);
    this.refreshUnread(identityId);
  }

  private refreshUnread(identityId: number): void {
    const mail = this.repo.getMailIdentity(identityId);
    if (!mail) return;
    const unread = (this.db.prepare('SELECT COUNT(*) AS c FROM mail_messages WHERE identity_id = ? AND mail_account_id = ? AND seen = 0').get(identityId, mail.mailAccountId) as Row).c;
    this.db.prepare('UPDATE mail_identities SET unread_count = ? WHERE identity_id = ?').run(unread, identityId);
    this.bus.emit({ type: 'mail.updated', identityId, data: { unread } });
  }

  /** Manually assign a message to an identity. Only identities using the same mailbox qualify. */
  assignMessage(messageId: number, identityId: number | null): StoredMessage {
    const row = this.getRow(messageId);
    if (identityId !== null) {
      const { account } = this.mailboxForIdentity(identityId);
      if (account.id !== row.mailAccountId) {
        throw new IsolationError('A message can only be assigned to an identity that uses the same mailbox');
      }
    }
    this.db.prepare('UPDATE mail_messages SET identity_id = ?, manual_assignment = ? WHERE id = ?').run(identityId, identityId === null ? 0 : 1, messageId);
    this.audit.record(identityId, 'Mail assigned to identity', { message: messageId, previous: row.identityId ?? 'none' });
    if (row.identityId) this.refreshUnread(row.identityId);
    if (identityId) this.refreshUnread(identityId);
    return this.getRow(messageId);
  }

  // ------------------------------------------------------------ SMTP (optional)

  async sendMail(identityId: number, msg: { to: string; subject: string; text: string }): Promise<void> {
    const { account, mail } = this.mailboxForIdentity(identityId);
    if (!account.smtpHost) throw new ValidationError('SMTP is not configured for this mailbox');
    const auth = await this.authFor(account);
    const transport = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort ?? 587,
      secure: (account.smtpPort ?? 587) === 465,
      auth: auth.accessToken ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : { user: auth.user, pass: auth.pass },
      logger: false,
    } as any);
    await transport.sendMail({ from: mail.address, to: msg.to, subject: msg.subject, text: msg.text });
    this.audit.record(identityId, 'Mail sent', { to: msg.to });
  }

  // ------------------------------------------------------------ aliases

  listAliasProviders(): AliasProviderRecord[] {
    return (this.db.prepare('SELECT * FROM alias_providers ORDER BY id').all() as Row[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      config: JSON.parse(r.config_json),
      credentialRef: r.credential_ref,
    }));
  }

  async createAliasProvider(input: { kind: 'plus' | 'cloudflare'; label: string; config: Record<string, string>; apiToken?: string }): Promise<AliasProviderRecord> {
    if (input.kind === 'plus' && !input.config.baseAddress) throw new ValidationError('baseAddress is required');
    if (input.kind === 'cloudflare') {
      if (!input.config.zoneId || !input.config.domain) throw new ValidationError('zoneId and domain are required');
      if (!input.apiToken) throw new ValidationError('Cloudflare API token is required');
    }
    const info = this.db
      .prepare('INSERT INTO alias_providers (kind, label, config_json) VALUES (?, ?, ?)')
      .run(input.kind, input.label || input.kind, JSON.stringify(input.config));
    const id = Number(info.lastInsertRowid);
    if (input.apiToken) {
      const ref = refs.aliasProvider(id);
      await this.vault.store.set(ref, input.apiToken);
      this.db.prepare('UPDATE alias_providers SET credential_ref = ? WHERE id = ?').run(ref, id);
    }
    this.audit.record(null, 'Alias provider added', { kind: input.kind, label: input.label });
    return this.listAliasProviders().find((p) => p.id === id)!;
  }

  async deleteAliasProvider(id: number): Promise<void> {
    await this.vault.store.delete(refs.aliasProvider(id));
    this.db.prepare('DELETE FROM alias_providers WHERE id = ?').run(id);
  }

  private aliasManagerFor(account: MailAccount): AliasManager | null {
    if (!account.aliasProviderId) return null;
    const p = this.listAliasProviders().find((x) => x.id === account.aliasProviderId);
    if (!p) return null;
    if (p.kind === 'plus') {
      return new PlusAddressingAliasManager(p.config.baseAddress || account.username, () =>
        this.repo.listMailIdentitiesForAccount(account.id).map((m) => m.address),
      );
    }
    return new CloudflareAliasManager(
      { zoneId: p.config.zoneId, domain: p.config.domain },
      async () => {
        const t = p.credentialRef ? await this.vault.store.get(p.credentialRef) : null;
        if (!t) throw new ValidationError('Cloudflare API token missing in vault');
        return t;
      },
      this.http,
    );
  }

  async listAliases(mailboxId: number): Promise<Array<MailAlias & { identityId: number | null }>> {
    const aliases = await this.providerFor(mailboxId).listAliases();
    const assigned = new Map(this.repo.listMailIdentitiesForAccount(mailboxId).map((m) => [m.address.toLowerCase(), m.identityId]));
    return aliases.map((a) => ({ ...a, identityId: assigned.get(a.address) ?? null }));
  }

  /** Creates an alias via the provider API and (optionally) assigns it to an identity. */
  async createAlias(mailboxId: number, localPart: string, assignTo?: number): Promise<MailAlias> {
    const account = this.repo.getMailAccount(mailboxId);
    const alias = await this.providerFor(mailboxId).createAlias(localPart, account.username);
    this.audit.record(assignTo ?? null, 'Mail alias created', { alias: alias.address, mailbox: mailboxId });
    if (assignTo !== undefined) this.repo.assignMail(assignTo, { mailAccountId: mailboxId, address: alias.address, isAlias: true });
    return alias;
  }

  async deleteAlias(mailboxId: number, address: string): Promise<void> {
    const owner = this.repo.listMailIdentitiesForAccount(mailboxId).find((m) => m.address.toLowerCase() === address.toLowerCase());
    if (owner) throw new ValidationError(`Alias is still assigned to identity ${owner.identityId} – unassign it first`);
    await this.providerFor(mailboxId).deleteAlias(address);
    this.audit.record(null, 'Mail alias deleted', { alias: address });
  }

  /** Short, non-sensitive hint for audit/UI summaries. */
  static codeHint(code: string): string {
    return maskCode(code);
  }
}
