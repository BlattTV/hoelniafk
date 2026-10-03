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
 *  - Resource packs are always answered, each pack by its own id (accepted → downloaded → loaded),
 *    in the play and in the configuration phase. The library only answers during configuration and
 *    only for the latest pack: a network that sends several packs on a server switch (e.g. a network
 *    pack plus a server pack) then waits forever for the first one – the player hangs in the
 *    configuration phase of the next server (no world, no chat) until the connection drops.
 *  - Nothing play-only is sent during the configuration phase: chat typed then is held back and sent
 *    once the player is in the world again (Velocity decodes such packets with the configuration
 *    registry and kicks: "An internal error occurred in your connection.").
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const MAX_COOKIES = 64;
const MAX_QUEUED_CHAT = 20;
const CHAT_WAIT_MS = 60_000;
// resource_pack_receive results
const RP_LOADED = 0;
const RP_ACCEPTED = 3;
const RP_DOWNLOADED = 4;

/** Packets whose checksum field the protocol data types as a SIGNED byte (chat_message uses u8 – same wire byte). */
const CHAT_PACKETS = new Set(['chat_command_signed']);

/** Byte value as Java's (byte) cast gives it: same low 8 bits, range -128..127 (0 stays 1, like vanilla). */
export function signedByte(n: number): number {
  const b = ((n & 0xff) << 24) >> 24;
  return b === 0 ? 1 : b;
}

export function installVanillaCompat(bot: any): void {
  const client = bot?._client;
  if (!client || client.__hoelniCompat) return;
  client.__hoelniCompat = true;

  // ---- chat checksum (1.21.5+): the library computes it as 0..255, but signed commands type the field as a
  // signed byte (-128..127) – every command with a checksum above 127 failed to send ("value out of range").
  const write = client.write.bind(client);
  client.write = (name: string, params: any) => {
    if (CHAT_PACKETS.has(name) && params && typeof params.checksum === 'number') params = { ...params, checksum: signedByte(params.checksum) };
    return write(name, params);
  };

  // ---- pushed by other entities, like the vanilla client (the physics library has no entity collision)
  if (typeof bot.on === 'function') bot.on('physicsTick', () => pushFromEntities(bot));

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

  // ---- resource packs: answered like a vanilla client that has the pack enabled (not downloaded –
  // the AFK session does not render anything)
  const note = (kind: string, detail: string) => bot.emit?.('hoelni:note', kind, detail);
  const answerPack = (uuid: string | undefined, kind: string) => {
    const w = (result: number) => {
      try {
        client.write('resource_pack_receive', uuid ? { uuid, result } : { result });
      } catch {
        /* state without resource packs */
      }
    };
    w(RP_ACCEPTED);
    if (uuid) w(RP_DOWNLOADED); // 1.20.3+ (packs with id) – older clients know no "downloaded" status
    w(RP_LOADED);
    note('resource-pack', `Server resource pack answered (${kind}, ${client.state})`);
  };
  const onAddPack = (p: any) => answerPack(p?.uuid ? String(p.uuid) : undefined, 'add');
  const onSendPack = (p: any) => answerPack(p?.uuid ? String(p.uuid) : undefined, 'send');
  client.on('add_resource_pack', onAddPack);
  client.on('resource_pack_send', onSendPack);
  const ours = new Map<string, (...a: any[]) => void>([
    ['add_resource_pack', onAddPack],
    ['resource_pack_send', onSendPack],
  ]);
  const dropLibraryPackHandlers = () => {
    // the library's own answer (latest pack only, configuration only) would answer packs twice
    for (const [ev, mine] of ours) for (const l of client.listeners(ev)) if (l !== mine) client.removeListener(ev, l as any);
    // a chat line the library cannot format (unknown chat type, missing name) must not end the session
    for (const ev of ['playerChat', 'systemChat']) {
      for (const l of client.listeners(ev) as Array<(...a: any[]) => void>) {
        if ((l as any).__hoelni) continue;
        const safe = (...a: any[]) => {
          try {
            l(...a);
          } catch (e) {
            note('error', `Chat line could not be read: ${(e as Error)?.message ?? e}`);
            const d = a[0] ?? {};
            if (ev === 'playerChat' && d.plainMessage != null) {
              const name = plainText(d.senderName);
              const text = name ? `<${name}> ${d.plainMessage}` : String(d.plainMessage);
              try {
                const ChatMessage = require('prismarine-chat')(bot.registry);
                bot.emit?.('messagestr', text, 'chat', new ChatMessage({ text }), d.sender);
              } catch {
                /* no registry yet */
              }
            }
          }
        };
        safe.__hoelni = true;
        client.removeListener(ev, l);
        client.on(ev, safe);
      }
    }
  };
  client.on('show_dialog', () => note('server-dialog', `The server shows a dialog (${client.state}) – it cannot be answered automatically`));

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
  if (typeof bot.chat === 'function') {
    wrapChat();
    dropLibraryPackHandlers();
  } else if (typeof bot.once === 'function')
    bot.once('inject_allowed', () =>
      setImmediate(() => {
        wrapChat();
        dropLibraryPackHandlers();
      }),
    );
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

/**
 * Chat line as the vanilla client shows it. Servers like Paper render the whole line (name, prefix,
 * message) into the message's unsigned content and send it with a chat type that only shows the
 * content – the library prints the bare signed text then ("eeyyy" instead of "LiebUFF » eeyyy").
 * The vanilla client shows the unsigned content; if even that lacks the sender, the name is put
 * in front like the default chat format.
 */
export function chatLine(text: string, position: string | undefined, msg: any, sender: string | undefined, players?: Record<string, any>, lang?: Record<string, string>): string {
  let line = String(text ?? '');
  // the library stops at 8 nested components and drops the rest – servers that colour every word or
  // letter (gradients, legacy colour codes) nest much deeper, so lines came out empty or cut off
  const full = componentText(msg, lang);
  if (full.length > line.length) line = full;
  if (position !== 'chat') return line;
  try {
    const unsigned = msg?.unsigned ? componentText(msg.unsigned, lang) || msg.unsigned.toString?.() : '';
    if (unsigned) line = unsigned;
  } catch {
    /* keep the plain text */
  }
  const name = sender ? Object.values(players ?? {}).find((p: any) => p?.uuid === sender)?.username : undefined;
  if (name && !line.includes(name)) line = `<${name}> ${line}`;
  return line;
}

const MAX_LINE = 4096;
/**
 * Plain text of a parsed chat message (prismarine-chat ChatMessage: text / translate+with / extra …)
 * like its toString(), but without the depth limit of 8 (bounded by length and a generous depth).
 */
export function componentText(msg: any, lang?: Record<string, string>): string {
  let out = '';
  const walk = (c: any, depth: number): string => {
    if (c == null || depth > 512) return '';
    if (typeof c === 'string' || typeof c === 'number') return String(c);
    if (typeof c !== 'object') return '';
    let s = '';
    if (typeof c.text === 'string' || typeof c.text === 'number') s += String(c.text);
    else if (typeof c[''] === 'string' || typeof c[''] === 'number') s += String(c['']);
    else if (typeof c.translate === 'string') {
      const args: string[] = Array.isArray(c.with) ? c.with.map((w: any) => walk(w, depth + 1)) : [];
      const format = lang?.[c.translate] ?? (typeof c.fallback === 'string' ? c.fallback : c.translate);
      s += formatTranslation(format, args);
    } else if (typeof c.selector === 'string') s += c.selector;
    else if (typeof c.keybind === 'string') s += c.keybind;
    else if (c.score && typeof c.score === 'object' && c.score.name && c.score.objective) s += `<score:${c.score.name}:${c.score.objective}>`;
    if (Array.isArray(c.extra)) {
      for (const e of c.extra) {
        s += walk(e, depth + 1);
        if (s.length > MAX_LINE) break;
      }
    }
    return s;
  };
  try {
    out = walk(msg, 0);
  } catch {
    return '';
  }
  return out.replace(/§[0-9a-fk-orx]/gi, '').replace(/\0/g, '').slice(0, MAX_LINE);
}

/** Minecraft translation format: %s, %1$s and %% (like the vanilla client). */
function formatTranslation(format: string, args: string[]): string {
  let next = 0;
  return format.replace(/%(?:(\d+)\$)?([sd%])/g, (_m, pos: string | undefined, kind: string) => {
    if (kind === '%') return '%';
    const i = pos ? Number(pos) - 1 : next++;
    return args[i] ?? '';
  });
}

/** Plain text of a JSON text component (string form as the protocol library hands it over). */
function plainText(json: unknown): string {
  if (json == null) return '';
  try {
    const walk = (c: any): string =>
      typeof c === 'string' ? c : Array.isArray(c) ? c.map(walk).join('') : `${c?.text ?? ''}${(c?.extra ?? []).map(walk).join('')}`;
    return walk(typeof json === 'string' ? JSON.parse(json) : json);
  } catch {
    return String(json);
  }
}

/** Entities that push the player when they overlap (vanilla: everything pushable except item/xp/arrows …). */
const NOT_PUSHING = /^(item|experience_orb|arrow|spectral_arrow|trident|snowball|egg|ender_pearl|fireball|small_fireball|item_frame|glow_item_frame|painting|armor_stand|marker|area_effect_cloud|falling_block|tnt|lightning_bolt|text_display|item_display|block_display|interaction)$/;

/**
 * Vanilla Entity#push for the local player: every overlapping entity pushes it away a little each tick
 * (0.05 × direction, weaker when farther apart). Called after each physics tick.
 */
export function pushFromEntities(bot: any): void {
  const me = bot?.entity;
  if (!me?.position || !me.velocity || !bot.entities) return;
  if (bot._client && bot._client.state !== 'play') return;
  if (bot.game?.gameMode === 'spectator') return;
  const w = (me.width ?? 0.6) / 2;
  const hgt = me.height ?? 1.8;
  for (const e of Object.values(bot.entities) as any[]) {
    if (!e || e === me || !e.position || NOT_PUSHING.test(String(e.name ?? ''))) continue;
    if (e.type === 'player' && e.gameMode === 3) continue;
    const ew = (e.width ?? 0.6) / 2;
    const eh = e.height ?? 1.8;
    // bounding boxes overlap?
    if (Math.abs(e.position.x - me.position.x) >= w + ew || Math.abs(e.position.z - me.position.z) >= w + ew) continue;
    if (e.position.y >= me.position.y + hgt || me.position.y >= e.position.y + eh) continue;
    let dx = e.position.x - me.position.x;
    let dz = e.position.z - me.position.z;
    let d = Math.max(Math.abs(dx), Math.abs(dz));
    if (d < 0.01) continue;
    d = Math.sqrt(d);
    dx /= d;
    dz /= d;
    const f = Math.min(1, 1 / d);
    me.velocity.x -= dx * f * 0.05;
    me.velocity.z -= dz * f * 0.05;
  }
}
