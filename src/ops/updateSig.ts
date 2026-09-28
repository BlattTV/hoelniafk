/**
 * Verification of signed release manifests from the update server
 * (update-server/src/sign.mjs): Ed25519 over the canonical JSON of the manifest.
 */
import crypto from 'node:crypto';

export interface ReleaseManifest {
  schema: number;
  product: string;
  build: number;
  version: string;
  commit: string | null;
  branch: string | null;
  createdAt: string;
  notes: string[];
  lockHash: string | null;
  backend: { file: string; sha256: string; size: number };
  installer: { file: string; sha256: string; size: number; desktopVersion: string | null } | null;
}

export interface SignedEnvelope {
  manifest: ReleaseManifest;
  signature: string;
  keyId: string;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function keyFingerprint(publicB64: string): string {
  const h = crypto.createHash('sha256').update(Buffer.from(publicB64, 'base64')).digest('hex').slice(0, 32);
  return h.match(/.{4}/g)!.join(':');
}

export function verifyEnvelope(env: SignedEnvelope, publicB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicB64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, Buffer.from(canonical(env.manifest)), key, Buffer.from(env.signature, 'base64'));
  } catch {
    return false;
  }
}
