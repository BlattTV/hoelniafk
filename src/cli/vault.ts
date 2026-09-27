/**
 * Vault maintenance CLI.
 *
 *   npm run vault -- status
 *   npm run vault -- export-recovery --out hoelni-recovery.json
 *   npm run vault -- recover --kit hoelni-recovery.json
 *
 * The recovery passphrase is read from HOELNI_RECOVERY_PASSPHRASE or prompted.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../config.js';
import { createKeyProvider } from '../vault/keyProviders.js';
import { EncryptedFileVault, type RecoveryKit } from '../vault/vault.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function passphrase(confirm: boolean): Promise<string> {
  if (process.env.HOELNI_RECOVERY_PASSPHRASE) return process.env.HOELNI_RECOVERY_PASSPHRASE;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string) =>
    new Promise<string>((resolve) => {
      const out = process.stdout as any;
      const orig = out.write.bind(out);
      rl.question(q, (a) => {
        out.write = orig;
        orig('\n');
        resolve(a);
      });
      out.write = (chunk: string) => (chunk.includes(q) ? orig(chunk) : true); // hide typed characters
    });
  const p1 = await ask('Recovery passphrase (min. 12 characters): ');
  if (confirm) {
    const p2 = await ask('Repeat passphrase: ');
    if (p1 !== p2) throw new Error('Passphrases do not match');
  }
  rl.close();
  return p1;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const config = loadConfig();
  const vaultFile = path.join(config.dataDir, 'vault.json');
  const provider = createKeyProvider(config.vault.keyProvider, path.join(config.dataDir, 'vault.key.dpapi'));
  switch (cmd) {
    case 'status': {
      if (!fs.existsSync(vaultFile)) {
        console.log(`No vault at ${vaultFile}`);
        return;
      }
      const v = await EncryptedFileVault.open(vaultFile, provider);
      const refs = await v.list();
      console.log(`Vault: ${vaultFile}\nBackend: ${v.backend}\nSecrets: ${refs.length}`);
      for (const r of refs) console.log(`  ${r}`);
      return;
    }
    case 'export-recovery': {
      const out = arg('out') ?? 'hoelni-vault-recovery.json';
      const v = await EncryptedFileVault.open(vaultFile, provider);
      const kit = v.exportRecoveryKit(await passphrase(true));
      fs.writeFileSync(out, JSON.stringify(kit, null, 2), { mode: 0o600 });
      console.log(`Recovery kit written to ${out}. Store it offline together with the passphrase (separately).`);
      return;
    }
    case 'recover': {
      const kitFile = arg('kit');
      if (!kitFile) throw new Error('--kit <file> is required');
      const kit = JSON.parse(fs.readFileSync(kitFile, 'utf8')) as RecoveryKit;
      const n = await EncryptedFileVault.recover(vaultFile, kit, await passphrase(false), provider);
      console.log(`Recovered ${n} secret(s); the vault is now protected by "${provider.name}".`);
      return;
    }
    default:
      console.log('Usage: npm run vault -- status | export-recovery [--out file] | recover --kit file');
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
