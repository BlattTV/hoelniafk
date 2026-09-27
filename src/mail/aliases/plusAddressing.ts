import { ValidationError } from '../../core/errors.js';
import type { AliasManager, MailAlias } from '../provider.js';

/**
 * Sub-addressing ("plus addressing"): user+mc01@example.com is delivered to
 * user@example.com by the provider itself (Gmail, Outlook.com, Fastmail, most
 * self-hosted servers). No API call is needed – the alias exists implicitly.
 */
export class PlusAddressingAliasManager implements AliasManager {
  readonly kind = 'plus';
  readonly canCreate = true;

  constructor(
    private readonly baseAddress: string,
    private readonly known: () => string[],
    private readonly separator = '+',
  ) {
    if (!/^[^@\s]+@[^@\s]+$/.test(baseAddress)) throw new ValidationError('Plus addressing needs a valid base address');
  }

  addressFor(tag: string): string {
    const [local, domain] = this.baseAddress.toLowerCase().split('@');
    return `${local}${this.separator}${tag.toLowerCase()}@${domain}`;
  }

  async listAliases(): Promise<MailAlias[]> {
    const [local, domain] = this.baseAddress.toLowerCase().split('@');
    const prefix = `${local}${this.separator}`;
    return this.known()
      .filter((a) => a.startsWith(prefix) && a.endsWith(`@${domain}`))
      .map((address) => ({ address, destination: this.baseAddress, enabled: true, providerRef: null }));
  }

  async createAlias(tag: string): Promise<MailAlias> {
    if (!/^[a-z0-9._-]{1,40}$/i.test(tag)) throw new ValidationError('Alias tag may only contain letters, digits, . _ -');
    return { address: this.addressFor(tag), destination: this.baseAddress, enabled: true, providerRef: null };
  }

  async deleteAlias(): Promise<void> {
    // Implicit aliases cannot be deleted – unassigning is enough.
  }
}
