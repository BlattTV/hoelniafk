import { IsolationError, ValidationError } from '../core/errors.js';

/**
 * Credential references are the only thing stored in SQLite:
 *
 *   vault://identity/7/mail          identity-owned secret
 *   vault://identity/7/minecraft     prismarine-auth token cache
 *   vault://identity/7/discord       Discord OAuth refresh token
 *   vault://identity/7/network/12    proxy credentials of network profile 12
 *   vault://mailbox/3                shared mailbox credentials (IMAP password / OAuth refresh token)
 *   vault://aliasprovider/2          alias provider API token
 *   vault://app/discord-client       app-level secret (OAuth client secret)
 */
const REF_RE = /^vault:\/\/(identity\/\d+|mailbox\/\d+|aliasprovider\/\d+|app)\/?([a-z0-9._/-]*)$/;

export type RefScope =
  | { kind: 'identity'; identityId: number; path: string }
  | { kind: 'mailbox'; mailboxId: number; path: string }
  | { kind: 'aliasprovider'; providerId: number; path: string }
  | { kind: 'app'; path: string };

export function parseRef(ref: string): RefScope {
  const m = REF_RE.exec(ref);
  if (!m || ref.includes('..')) throw new ValidationError(`Invalid credential ref: ${ref}`);
  const [scope, path] = [m[1], m[2]];
  if (scope.startsWith('identity/')) return { kind: 'identity', identityId: Number(scope.split('/')[1]), path };
  if (scope.startsWith('mailbox/')) return { kind: 'mailbox', mailboxId: Number(scope.split('/')[1]), path };
  if (scope.startsWith('aliasprovider/')) return { kind: 'aliasprovider', providerId: Number(scope.split('/')[1]), path };
  return { kind: 'app', path };
}

export const refs = {
  identity: (identityId: number, ...path: Array<string | number>) => `vault://identity/${identityId}/${path.join('/')}`,
  identityPrefix: (identityId: number) => `vault://identity/${identityId}/`,
  mailbox: (mailboxId: number) => `vault://mailbox/${mailboxId}`,
  aliasProvider: (providerId: number) => `vault://aliasprovider/${providerId}`,
  app: (name: string) => `vault://app/${name}`,
};

/** Throws unless `ref` is an identity-scoped reference owned by `identityId`. */
export function assertIdentityRef(ref: string, identityId: number): void {
  const scope = parseRef(ref);
  if (scope.kind !== 'identity' || scope.identityId !== identityId) {
    throw new IsolationError(`Credential ${ref} does not belong to identity ${identityId}`);
  }
}
