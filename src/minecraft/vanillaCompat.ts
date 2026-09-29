/**
 * Behaviour a vanilla client has and the protocol library lacks – needed behind proxies like
 * Velocity (server switches run through the configuration phase):
 *
 *  - Cookies (1.20.5+): servers/plugins store cookies and request them back (store_cookie /
 *    cookie_request), e.g. during a lobby → survival transfer. A vanilla client always answers a
 *    cookie request (with the stored value or empty); without the answer the server keeps the
 *    connection in the configuration phase forever.
 *  - A new chat session after every server switch: the vanilla client sends its chat key again and
 *    restarts message numbering / acknowledgements when it joins the next server (the library only
 *    does it on the first join – the next backend knows no chat session and rejects signed chat).
 *  - Nothing play-only is sent during the configuration phase: chat typed then is held back and sent
 *    once the player is in the world again (Velocity decodes such packets with the configuration
 *    registry and kicks: "An internal error occurred in your connection.").
 */

import crypto from 'node:crypto';

const MAX_COOKIES = 64;
const MAX_QUEUED_CHAT = 20;
const CHAT_WAIT_MS = 60_000;

export function installVanillaCompat(bot: any): void {
  const client = bot?._client;
  if (!client || client.__hoelniCompat) return;
  client.__hoelniCompat = true;

  // ---- cookies (kept for the lifetime of this connection, like the vanilla client)
  const cookies = new Map<string, Buffer>();
  client.on('store_cookie', (p: any) => {
    const key = String(p?.key ?? '');
    if (!key) return;
    if (!cookies.has(key) && cookies.size >= MAX_COOKIES) cookies.delete(cookies.keys().next().value!);
    cookies.set(key, Buffer.from(p.value ?? []));
  });
  client.on('cookie_request', (p: any) => {
    const key = String(p?.cookie ?? p?.key ?? '');
    try {
      client.write('cookie_response', { key, value: cookies.get(key) });
    } catch {
      /* state without a cookie response – nothing to answer */
    }
  });

  // ---- new chat session after each server switch (every "login" after the first one)
  let logins = 0;
  client.on('login', () => {
    if (++logins === 1) return; // the library sets up the first session itself
    resetChatSession(client);
  });

  // ---- chat only in the world (mineflayer defines bot.chat when its plugins load – wrap it then)
  const wrapChat = () => {
    if (typeof bot.chat !== 'function' || bot.chat.__hoelni) return;
    const queue: string[] = [];
    const original = bot.chat.bind(bot);
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      while (queue.length && client.state === 'play') original(queue.shift()!);
    };
    const chat = (text: string) => {
      if (client.state === 'play' && !queue.length) return original(text);
      if (queue.length < MAX_QUEUED_CHAT) queue.push(text);
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          queue.length = 0; // still not in the world after a minute – drop instead of sending into the wrong state
        }, CHAT_WAIT_MS);
        timer.unref?.();
      }
    };
    chat.__hoelni = true;
    bot.chat = chat;
    client.on('state', (next: string) => {
      if (next === 'play') setImmediate(flush);
    });
  };
  if (typeof bot.chat === 'function') wrapChat();
  else if (typeof bot.once === 'function') bot.once('inject_allowed', () => setImmediate(wrapChat));
}

/** Like the vanilla client on joining the next server: fresh chat state, chat key sent again. */
export function resetChatSession(client: any): void {
  try {
    if (client._lastSeenMessages) client._lastSeenMessages = new client._lastSeenMessages.constructor();
    if (client._signatureCache) client._signatureCache = new client._signatureCache.constructor();
    client._lastChatSignature = null;
    client._lastRejectedMessage = null;
    if (!client._session || !client.profileKeys) return; // unsigned chat – nothing to announce
    client._session = { index: 0, uuid: crypto.randomUUID() };
    const k = client.profileKeys;
    client.write('chat_session_update', {
      sessionUUID: client._session.uuid,
      expireTime: BigInt(k.expiresOn.getTime()),
      publicKey: k.public.export({ type: 'spki', format: 'der' }),
      signature: k.signatureV2,
    });
  } catch {
    /* older protocol without chat sessions */
  }
}

/** True while the connection is not in the world (server switch in progress). */
export const inConfiguration = (bot: any): boolean => !!bot?._client && bot._client.state !== 'play';
