/**
 * Signed release manifests. The same format is verified by the suite
 * (src/ops/updateSig.ts): Ed25519 over the canonical JSON of the manifest.
 */
import crypto from 'node:crypto';

/** JSON with sorted object keys – identical bytes on both sides. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

export function publicFromPrivate(privatePem) {
  return crypto.createPublicKey(privatePem).export({ type: 'spki', format: 'der' }).toString('base64');
}

/** Short, human-comparable fingerprint of a public key. */
export function fingerprint(publicB64) {
  const h = crypto.createHash('sha256').update(Buffer.from(publicB64, 'base64')).digest('hex').slice(0, 32);
  return h.match(/.{4}/g).join(':');
}

export function signManifest(manifest, privatePem) {
  const signature = crypto.sign(null, Buffer.from(canonical(manifest)), privatePem).toString('base64');
  return { manifest, signature, keyId: fingerprint(publicFromPrivate(privatePem)) };
}

export function verifyEnvelope(envelope, publicB64) {
  const key = crypto.createPublicKey({ key: Buffer.from(publicB64, 'base64'), format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(canonical(envelope.manifest)), key, Buffer.from(envelope.signature, 'base64'));
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
