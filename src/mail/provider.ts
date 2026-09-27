/**
 * Mail provider abstraction.
 *
 *   MailProvider
 *   ├── listAliases()
 *   ├── createAlias()
 *   ├── deleteAlias()
 *   ├── listMessages()
 *   └── getMessage()
 *
 * A provider is composed of a MessageSource (IMAP, optionally via OAuth2) and an
 * optional AliasManager. Alias managers only use officially supported provider APIs.
 */
import { NotSupportedError } from '../core/errors.js';

export interface MailAddress {
  address: string;
  name?: string;
}

export interface MessageHeader {
  uid: number;
  messageId: string | null;
  from: MailAddress | null;
  to: string[];
  subject: string;
  date: string | null;
  seen: boolean;
  hasAttachments: boolean;
}

export interface RawMessage {
  uid: number;
  source: Buffer;
}

export interface MessageSource {
  listMessages(opts: { limit: number }): Promise<MessageHeader[]>;
  getMessage(uid: number): Promise<RawMessage>;
  setSeen(uid: number, seen: boolean): Promise<void>;
  test(): Promise<{ total: number; unseen: number }>;
}

export interface MailAlias {
  address: string;
  /** Where the alias delivers to. */
  destination: string | null;
  enabled: boolean;
  providerRef: string | null;
}

export interface AliasManager {
  readonly kind: string;
  /** Whether new aliases can be created via an official API. */
  readonly canCreate: boolean;
  listAliases(): Promise<MailAlias[]>;
  createAlias(localPart: string, destination: string): Promise<MailAlias>;
  deleteAlias(address: string): Promise<void>;
}

export interface MailProvider extends MessageSource {
  listAliases(): Promise<MailAlias[]>;
  createAlias(localPart: string, destination: string): Promise<MailAlias>;
  deleteAlias(address: string): Promise<void>;
}

export function composeProvider(source: MessageSource, aliases: AliasManager | null): MailProvider {
  const noAliases = () => {
    throw new NotSupportedError('This mailbox has no alias provider configured');
  };
  return {
    listMessages: (o) => source.listMessages(o),
    getMessage: (uid) => source.getMessage(uid),
    setSeen: (uid, seen) => source.setSeen(uid, seen),
    test: () => source.test(),
    listAliases: async () => (aliases ? aliases.listAliases() : []),
    createAlias: async (l, d) => (aliases ? aliases.createAlias(l, d) : noAliases()),
    deleteAlias: async (a) => (aliases ? aliases.deleteAlias(a) : noAliases()),
  };
}
