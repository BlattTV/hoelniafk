/**
 * Behaviour a vanilla client has and the protocol library lacks – needed behind proxies like
 * Velocity (server switches run through the configuration phase):
 *
 *  - Cookies (1.20.5+): servers/plugins store cookies and request them back (store_cookie /
 *    cookie_request), e.g. during a lobby → survival transfer. A vanilla client always answers a
 *    cookie request (with the stored value or empty); without the answer the server keeps the
 *    connection in the configuration phase forever.
 *  - Nothing play-only is sent during the configuration phase: chat typed then is held back and sent
 *    once the player is in the world again (Velocity decodes such packets with the configuration
 *    registry and kicks: "An internal error occurred in your connection.").
 */

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

/** True while the connection is not in the world (server switch in progress). */
export const inConfiguration = (bot: any): boolean => !!bot?._client && bot._client.state !== 'play';
