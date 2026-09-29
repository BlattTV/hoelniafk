import crypto from 'node:crypto';
import mineflayer from 'mineflayer';
import { openSocket, resolveMinecraftTarget } from '../network/connector.js';
import type { HostBot, HostBotFactory } from '../runtime/host/hostCore.js';
import type { JavaSession } from '../runtime/types.js';

/**
 * Real bot factory based on mineflayer (runs inside a runtime host).
 *  - The TCP connection (incl. the version-detection ping) is always opened through
 *    the session's own network profile (bind IP / SOCKS5 / HTTP CONNECT).
 *  - Microsoft sessions get their access token + chat-signing keys from the main
 *    process via `getJavaSession()`; the host never sees the refresh tokens.
 */
export const mineflayerBotFactory: HostBotFactory = (spec, getJavaSession) => {
  const { network, server } = spec;
  const connect = (client: any) => {
    resolveMinecraftTarget(server.host, server.port)
      .then((target) => openSocket(network.profile, network.secret, target))
      .then((socket) => {
        client.setSocket(socket);
        client.emit('connect');
      })
      .catch((err) => {
        client.emit('error', err);
        client.emit('end', 'connectFailed');
      });
  };

  const microsoftAuth = (client: any, options: any) => {
    getJavaSession()
      .then((js) => {
        // unsigned chat: no chat keys → no chat session, messages go out without a signature
        applyJavaSession(client, options, spec.unsignedChat ? { ...js, profileKeys: null } : js);
        options.connect(client);
      })
      .catch((err) => {
        client.emit('error', err);
        client.emit('end', 'authFailed');
      });
  };

  const bot = mineflayer.createBot({
    host: server.host,
    port: server.port,
    username: spec.username,
    auth: spec.auth === 'microsoft' ? microsoftAuth : 'offline',
    version: server.version || undefined,
    hideErrors: true,
    checkTimeoutInterval: 60_000,
    viewDistance: spec.viewDistance,
    connect,
  } as any);
  return bot as unknown as HostBot;
};

/**
 * Mojang's certificate endpoint labels its keys "RSA PRIVATE KEY" / "RSA PUBLIC KEY" although the
 * content is PKCS#8 / SPKI – parsing the PEM as-is fails with "asn1 … wrong tag". Like prismarine-auth,
 * decode the base64 body and read it as DER; a correctly labelled PEM still works as fallback.
 */
export function profileKey(pem: string, kind: 'public' | 'private'): crypto.KeyObject {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  try {
    return kind === 'private' ? crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }) : crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return kind === 'private' ? crypto.createPrivateKey(pem) : crypto.createPublicKey(pem);
  }
}

/** Mirrors minecraft-protocol's microsoftAuth.authenticate() with a pre-fetched session. */
export function applyJavaSession(client: any, options: any, js: JavaSession): void {
  const session = {
    accessToken: js.accessToken,
    selectedProfile: js.profile,
    availableProfile: [js.profile],
  };
  client.session = session;
  client.username = js.profile.name;
  options.haveCredentials = true;
  options.accessToken = js.accessToken;
  if (js.profileKeys) {
    const k = js.profileKeys;
    client.profileKeys = {
      publicPEM: k.publicPEM,
      privatePEM: k.privatePEM,
      public: profileKey(k.publicPEM, 'public'),
      private: profileKey(k.privatePEM, 'private'),
      signature: Buffer.from(k.signature, 'base64'),
      signatureV2: Buffer.from(k.signatureV2, 'base64'),
      expiresOn: new Date(k.expiresOn),
    };
  }
  client.emit('session', session);
}
