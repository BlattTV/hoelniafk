import type { IdentityVault } from '../vault/vault.js';

/**
 * prismarine-auth cache factory backed by the identity-scoped vault.
 * All token caches (MSA, XBL, Minecraft) of one identity are stored encrypted
 * under `vault://identity/<id>/minecraft` – never on disk in plain text.
 */
export function vaultCacheFactory(vault: IdentityVault) {
  const ref = vault.ref('minecraft');
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const readAll = async (): Promise<Record<string, any>> => (await vault.getJson<Record<string, any>>(ref)) ?? {};

  return ({ cacheName }: { username: string; cacheName: string }) => ({
    async reset() {
      await serial(async () => {
        const all = await readAll();
        delete all[cacheName];
        await vault.setJson(ref, all);
      });
    },
    async getCached() {
      return serial(async () => (await readAll())[cacheName] ?? {});
    },
    async setCached(value: any) {
      await serial(async () => {
        const all = await readAll();
        all[cacheName] = value;
        await vault.setJson(ref, all);
      });
    },
    async setCachedPartial(value: any) {
      await serial(async () => {
        const all = await readAll();
        all[cacheName] = { ...(all[cacheName] ?? {}), ...value };
        await vault.setJson(ref, all);
      });
    },
  });
}
