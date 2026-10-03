/**
 * Behind Velocity: a server switch (lobby → survival) runs through the configuration phase, where the
 * server may request cookies and waits for the answer. Without it the client stayed in configuration
 * and the next chat message was decoded by Velocity's configuration handler → "An internal error
 * occurred in your connection." Real protocol (minecraft-protocol 1.21.11) on both sides.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { installVanillaCompat } from '../src/minecraft/vanillaCompat.js';

const require = createRequire(import.meta.url);
const mc = require('minecraft-protocol');

const until = async (cond: () => boolean, ms = 8000, what = 'condition') => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('vanilla client behaviour behind a proxy', () => {
  it('answers cookie requests during a server switch and holds chat back until the player is in the world', async () => {
    const version = '1.21.11';
    const server = mc.createServer({ version, 'online-mode': false, port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = server.socketServer.address().port;
    const received: Array<{ state: string; name: string; data: any }> = [];
    let serverClient: any;
    server.on('playerJoin', (c: any) => {
      serverClient = c;
      c.on('packet', (data: any, meta: any) => received.push({ state: meta.state, name: meta.name, data }));
      c.write('login', { ...require('minecraft-data')(version).loginPacket, entityId: 1 }); // first join
      c.write('store_cookie', { key: 'hoelni:network', value: Buffer.from('secret-key') });
    });

    const client = mc.createClient({ version, host: '127.0.0.1', port, username: 'Tester', auth: 'offline' });
    const bot: any = { _client: client, chat: (t: string) => client.chat(t) };
    installVanillaCompat(bot);
    await until(() => !!serverClient && client.state === 'play' && typeof client.chat === 'function', 8000, 'in play');
    await new Promise((r) => setTimeout(r, 200));

    // proxy moves the player to another server: back into configuration
    serverClient.write('start_configuration', {});
    await until(() => received.some((p) => p.name === 'configuration_acknowledged'), 5000, 'ack');
    serverClient.state = 'configuration';
    serverClient.write('cookie_request', { cookie: 'hoelni:network' });
    bot.chat('hello while switching'); // typed during the switch
    await until(() => received.some((p) => p.name === 'cookie_response'), 5000, 'cookie answered');
    const answer = received.find((p) => p.name === 'cookie_response')!;
    expect(answer.state).toBe('configuration');
    expect(answer.data.key).toBe('hoelni:network');
    expect(Buffer.from(answer.data.value).toString()).toBe('secret-key');
    // nothing play-only was sent during configuration
    expect(received.filter((p) => p.state === 'configuration').map((p) => p.name)).not.toContain('chat_message');

    // server finishes the switch → the held-back chat goes out in play
    serverClient.once('finish_configuration', () => (serverClient.state = 'play')); // like a server: play right on the ack
    serverClient.write('finish_configuration', {});
    await until(() => received.some((p) => p.name === 'finish_configuration'), 5000, 'finish ack');
    await until(() => received.some((p) => p.name === 'chat_message'), 5000, 'chat after switch');
    const chat = received.find((p) => p.name === 'chat_message')!;
    expect(chat.state).toBe('play');
    expect(chat.data.message).toBe('hello while switching');

    // an unknown cookie is answered empty (like vanilla)
    serverClient.write('cookie_request', { cookie: 'other:unknown' });
    await until(() => received.filter((p) => p.name === 'cookie_response').length === 2, 5000, 'second cookie answer');
    expect(received.filter((p) => p.name === 'cookie_response')[1].data.value).toBeUndefined();

    // joining the next server: the vanilla client announces a NEW chat session (key sent again,
    // numbering from 0, acknowledgements reset) – simulate chat keys on this offline connection
    const crypto = await import('node:crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    client.profileKeys = { public: publicKey, private: privateKey, signatureV2: Buffer.alloc(8, 7), expiresOn: new Date(Date.now() + 3600_000) };
    client._session = { index: 12, uuid: 'old-session' };
    client._lastSeenMessages.pending = 3;
    const md = require('minecraft-data')(version);
    serverClient.write('login', { ...md.loginPacket, entityId: 99 });
    await until(() => received.some((p) => p.name === 'chat_session_update'), 5000, 'new chat session');
    const upd = received.find((p) => p.name === 'chat_session_update')!;
    expect(upd.state).toBe('play');
    expect(upd.data.sessionUUID).toBe(client._session.uuid);
    expect(client._session.uuid).not.toBe('old-session');
    expect(client._session.index).toBe(0);
    expect(client._lastSeenMessages.pending).toBe(0);
    // (the test server then rejects the fake key and disconnects – expected)
    expect(Buffer.from(upd.data.publicKey).equals(publicKey.export({ type: 'spki', format: 'der' }) as Buffer)).toBe(true);

    client.end();
    server.close();
  }, 30_000);

  it('answers every resource pack by its own id, in configuration and in play (mineflayer bot)', async () => {
    const version = '1.21.11';
    const mineflayer = require('mineflayer');
    const server = mc.createServer({ version, 'online-mode': false, port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = server.socketServer.address().port;
    const answers: Array<{ state: string; uuid: string; result: number }> = [];
    let serverClient: any;
    const md = require('minecraft-data')(version);
    server.on('playerJoin', (c: any) => {
      serverClient = c;
      c.on('packet', (data: any, meta: any) => {
        if (meta.name === 'resource_pack_receive') answers.push({ state: meta.state, uuid: data.uuid, result: data.result });
      });
      c.write('login', { ...md.loginPacket, entityId: 1 });
    });
    const bot = mineflayer.createBot({ version, host: '127.0.0.1', port, username: 'Packs', auth: 'offline' });
    installVanillaCompat(bot);
    const notes: string[] = [];
    bot.on('hoelni:note', (k: string) => notes.push(k));
    await until(() => !!serverClient && bot._client.state === 'play', 8000, 'in play');
    await new Promise((r) => setTimeout(r, 300)); // plugins loaded
    const pack = (uuid: string) => serverClient.write('add_resource_pack', { uuid, url: 'http://127.0.0.1/p.zip', hash: '', forced: true, promptMessage: undefined });
    const A = '11111111-1111-1111-1111-111111111111';
    const B = '22222222-2222-2222-2222-222222222222';
    const C = '33333333-3333-3333-3333-333333333333';
    // server switch: a network pack and a server pack right after each other
    serverClient.write('start_configuration', {});
    await until(() => bot._client.state === 'configuration', 5000, 'configuration');
    await new Promise((r) => setTimeout(r, 100));
    serverClient.state = 'configuration';
    pack(A);
    pack(B);
    await until(() => answers.filter((a) => a.result === 0).length === 2, 5000, 'both packs loaded');
    for (const id of [A, B]) expect(answers.filter((a) => a.uuid === id).map((a) => a.result)).toEqual([3, 4, 0]);
    expect(answers.every((a) => a.state === 'configuration')).toBe(true);
    // in play (the library would not answer at all there)
    serverClient.once('finish_configuration', () => (serverClient.state = 'play'));
    serverClient.write('finish_configuration', {});
    await until(() => bot._client.state === 'play', 5000, 'back in play');
    await new Promise((r) => setTimeout(r, 100));
    pack(C);
    await until(() => answers.some((a) => a.uuid === C && a.result === 0), 5000, 'play pack loaded');
    expect(answers.filter((a) => a.uuid === C).map((a) => a.result)).toEqual([3, 4, 0]);
    expect(answers).toHaveLength(9); // nothing answered twice
    expect(notes.filter((k) => k === 'resource-pack')).toHaveLength(3);
    bot.end();
    server.close();
  }, 30_000);

  it('chat lines keep the player name (server-rendered lines, chat types without the name)', async () => {
    const version = '1.21.11';
    const mineflayer = require('mineflayer');
    const nbt = require('prismarine-nbt');
    const { chatLine } = await import('../src/minecraft/vanillaCompat.js');
    const server = mc.createServer({ version, 'online-mode': false, port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = server.socketServer.address().port;
    const md = require('minecraft-data')(version);
    let sc: any;
    server.on('playerJoin', (c: any) => {
      sc = c;
      c.write('login', { ...md.loginPacket, entityId: 1 });
    });
    const bot = mineflayer.createBot({ version, host: '127.0.0.1', port, username: 'Me', auth: 'offline' });
    installVanillaCompat(bot);
    const lines: string[] = [];
    bot.on('messagestr', (t: string, pos: string, msg: any, sender: string) => lines.push(chatLine(t, pos, msg, sender, bot.players)));
    await until(() => !!sc && bot._client.state === 'play', 8000, 'in play');
    await new Promise((r) => setTimeout(r, 300));
    // like Paper: the chat plugin renders the whole line, sent with a chat type that shows only the content
    bot.registry.chatFormattingById[7] = { id: 7, name: 'paper:raw', formatString: '%s', parameters: ['content'] };
    const uuid = '11111111-2222-3333-4444-555555555555';
    sc.write('player_info', { action: { add_player: true, update_listed: true }, data: [{ uuid, player: { name: 'LiebUFF', properties: [] }, listed: true }] });
    const base = { senderUuid: uuid, index: 0, signature: undefined, plainMessage: 'eeyyy', timestamp: BigInt(Date.now()), salt: 0n, previousMessages: [], filterType: 0, networkName: nbt.comp({ text: nbt.string('LiebUFF') }), networkTargetName: undefined };
    sc.write('player_chat', { ...base, globalIndex: 0, unsignedChatContent: nbt.comp({ text: nbt.string('LiebUFF » eeyyy') }), type: { chatType: 7 } });
    sc.write('player_chat', { ...base, globalIndex: 1, plainMessage: 'moinn', unsignedChatContent: undefined, type: { chatType: 7 } });
    sc.write('player_chat', { ...base, globalIndex: 2, plainMessage: 'hallo', unsignedChatContent: undefined, type: { chatType: 0 } });
    // a line the library cannot format (outgoing whisper without target) – no crash, still shown
    sc.write('player_chat', { ...base, globalIndex: 3, plainMessage: 'psst', unsignedChatContent: undefined, type: { chatType: 3 } });
    await until(() => lines.length >= 4, 5000, 'chat lines');
    expect(lines.slice(-4)).toEqual(['LiebUFF » eeyyy', '<LiebUFF> moinn', '<LiebUFF> hallo', '<LiebUFF> psst']);
    // system messages as NBT, every word nested one level deeper (colour per word) and a mixed list
    const words = ['[HugoSMP]', ' Du', ' hast', ' gerade', ' 5', ' Sterne', ' erhalten', ' –', ' viel', ' Spaß', '!'];
    let comp: any = nbt.comp({ text: nbt.string(words[words.length - 1]), color: nbt.string('gold') });
    for (let i = words.length - 2; i >= 0; i--) comp = nbt.comp({ text: nbt.string(words[i]), color: nbt.string('yellow'), extra: nbt.list(nbt.comp([comp.value])) });
    sc.write('system_chat', { content: comp, isActionBar: false });
    sc.write('system_chat', { content: nbt.comp({ text: nbt.string(''), extra: nbt.list(nbt.comp([{ '': nbt.string('A ') }, { text: nbt.string('B'), bold: nbt.byte(1) }])) }), isActionBar: false });
    await until(() => lines.length >= 6, 5000, 'system lines');
    expect(lines.slice(-2)).toEqual(['[HugoSMP] Du hast gerade 5 Sterne erhalten – viel Spaß!', 'A B']);
    bot.end();
    server.close();
  }, 30_000);

  it('reports the configured client brand on join (vanilla or fabric)', async () => {
    const version = '1.21.11';
    const { mineflayerBotFactory } = await import('../src/minecraft/mineflayerBot.js');
    const server = mc.createServer({ version, 'online-mode': false, port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = server.socketServer.address().port;
    const md = require('minecraft-data')(version);
    const brands: string[] = [];
    server.on('playerJoin', (c: any) => {
      c.on('custom_payload', (p: any) => {
        if (/brand/.test(p.channel)) brands.push(p.data.subarray(1).toString());
      });
      c.write('login', { ...md.loginPacket, entityId: 1 });
    });
    const spec: any = { username: 'Brand01', auth: 'offline', brand: 'fabric', server: { host: '127.0.0.1', port, version }, network: { profile: null, secret: null }, viewDistance: 'tiny' };
    const bot: any = mineflayerBotFactory(spec, async () => { throw new Error('no'); });
    await until(() => brands.length > 0, 8000, 'brand');
    expect(brands[0]).toBe('fabric');
    bot.end();
    server.close();
  }, 30_000);

  it('keeps the exact server bytes of packets the library only partly understands (taken over games get them unchanged)', async () => {
    const version = '1.21.11';
    const { StateCache } = await import('../src/runtime/host/takeover.js');
    const server = mc.createServer({ version, 'online-mode': false, port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = server.socketServer.address().port;
    const md = require('minecraft-data')(version);
    let sc: any;
    server.on('playerJoin', (c: any) => {
      sc = c;
      c.write('login', { ...md.loginPacket, entityId: 1 });
    });
    const client = mc.createClient({ version, host: '127.0.0.1', port, username: 'Bytes01', auth: 'offline', hideErrors: true });
    const cache = new StateCache();
    const seen: Array<{ raw: Buffer; full: Buffer }> = [];
    client.on('packet', (data: any, meta: any, raw: Buffer, full: Buffer) => {
      if (meta.name === 'entity_equipment') seen.push({ raw, full });
      cache.record(meta.state, meta.name, data, full ?? raw); // as the session host does
    });
    await until(() => !!sc && client.state === 'play', 8000, 'in play');
    // a valid equipment packet followed by data the library does not know (like new item components)
    const valid = sc.serializer.createPacketBuffer({ name: 'entity_equipment', params: { entityId: 1, equipments: [{ slot: 0, item: { itemCount: 0 } }] } });
    const withUnknown = Buffer.concat([valid, Buffer.from([1, 2, 3, 4, 5])]);
    sc.writeRaw(withUnknown);
    await until(() => seen.length === 1, 5000, 'equipment packet');
    expect(seen[0].raw.length).toBe(valid.length); // what the library read …
    expect(seen[0].full.equals(withUnknown)).toBe(true); // … and what the server really sent
    const recorded = cache.entities.get(1)?.state.get('entity_equipment')?.[0];
    expect(Buffer.from(recorded!).equals(withUnknown)).toBe(true);
    client.end();
    server.close();
  }, 30_000);

  it('signed commands go out when the 1.21.5+ chat checksum is above 127 (signed byte like vanilla)', async () => {
    const { signedByte } = await import('../src/minecraft/vanillaCompat.js');
    expect(signedByte(174)).toBe(-82);
    expect(signedByte(127)).toBe(127);
    expect(signedByte(256)).toBe(1); // 0 → 1 like vanilla
    const version = '1.21.11';
    const server = mc.createServer({ version, 'online-mode': false, port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = server.socketServer.address().port;
    const md = require('minecraft-data')(version);
    let sc: any;
    const got: any[] = [];
    server.on('playerJoin', (c: any) => {
      sc = c;
      c.on('packet', (d: any, meta: any) => /^chat_/.test(meta.name) && got.push({ name: meta.name, ...d }));
      c.write('login', { ...md.loginPacket, entityId: 1 });
    });
    const client = mc.createClient({ version, host: '127.0.0.1', port, username: 'Sum01', auth: 'offline' });
    installVanillaCompat({ _client: client });
    const errors: string[] = [];
    client.on('error', (e: Error) => errors.push(e.message));
    await until(() => !!sc && client.state === 'play', 8000, 'in play');
    // what the library produces for a checksum of 174
    client.write('chat_command_signed', { command: 'server', timestamp: BigInt(Date.now()), salt: 0n, argumentSignatures: [], messageCount: 0, acknowledged: Buffer.alloc(3), checksum: 174 });
    client.write('chat_message', { message: 'hi', timestamp: BigInt(Date.now()), salt: 0n, signature: undefined, offset: 0, acknowledged: Buffer.alloc(3), checksum: 200 });
    await until(() => got.length === 2, 5000, 'chat packets arrive');
    expect(errors).toEqual([]);
    // same byte on the wire (0xAE / 0xC8), each in the range its packet type expects
    expect(got.map((g) => [g.name, g.checksum])).toEqual([['chat_command_signed', -82], ['chat_message', 200]]);
    client.end();
    server.close();
  }, 30_000);

  it('is pushed away by overlapping players like a vanilla client (no walking through others)', async () => {
    const { pushFromEntities } = await import('../src/minecraft/vanillaCompat.js');
    const v = (x: number, y: number, z: number) => ({ x, y, z });
    const me = { position: v(0, 64, 0), velocity: v(0, 0, 0), width: 0.6, height: 1.8 };
    const bot: any = {
      entity: me,
      game: { gameMode: 'survival' },
      entities: {
        1: me,
        2: { name: 'player', type: 'player', position: v(0.3, 64, 0), width: 0.6, height: 1.8 }, // overlaps, east of me
        3: { name: 'player', type: 'player', position: v(5, 64, 0), width: 0.6, height: 1.8 }, // far away
        4: { name: 'item', type: 'object', position: v(-0.1, 64, 0), width: 0.25, height: 0.25 }, // items never push
      },
    };
    pushFromEntities(bot);
    // vanilla: d = sqrt(0.3); dx = 0.3/d; f = min(1, 1/d) = 1 → velocity -= dx * 0.05
    expect(me.velocity.x).toBeCloseTo(-(0.3 / Math.sqrt(0.3)) * 0.05, 6);
    expect(me.velocity.z).toBe(0);
    // standing above the other player's head: no push
    me.velocity.x = 0;
    me.position.y = 66;
    pushFromEntities(bot);
    expect(me.velocity.x).toBe(0);
  });

  it('deeply nested chat components (colour per word / gradients) come out complete', async () => {
    const { chatLine, componentText } = await import('../src/minecraft/vanillaCompat.js');
    const ChatMessage = require('prismarine-chat')('1.21.4');
    // legacy colour conversion nests every colour change one level deeper
    const words = ['[HugoSMP]', ' Du', ' hast', ' gerade', ' 5', ' Sterne', ' erhalten', ' –', ' viel', ' Spaß', '!'];
    let json: any = { text: words[words.length - 1], color: 'gold' };
    for (let i = words.length - 2; i >= 0; i--) json = { text: words[i], color: i % 2 ? 'yellow' : 'gray', extra: [json] };
    const empty: any = { text: '' };
    let wrapped: any = { text: '', extra: [{ text: 'Willkommen zurück!' }] };
    for (let i = 0; i < 12; i++) wrapped = { text: '', extra: [wrapped] };
    const msg = new ChatMessage(json);
    expect(msg.toString()).not.toContain('Spaß'); // the library cuts it off after 8 levels …
    const line = chatLine(msg.toString(), 'system', msg, undefined, {});
    expect(line).toBe('[HugoSMP] Du hast gerade 5 Sterne erhalten – viel Spaß!'); // … we do not
    const deep = new ChatMessage(wrapped);
    expect(deep.toString()).toBe('');
    expect(chatLine(deep.toString(), 'system', deep, undefined, {})).toBe('Willkommen zurück!');
    expect(componentText(new ChatMessage(empty))).toBe('');
    // translations with positional arguments
    const tr = new ChatMessage({ translate: 'chat.type.text', with: [{ text: 'Hugo' }, { text: 'hallo' }] });
    expect(componentText(tr, { 'chat.type.text': '<%s> %s' })).toBe('<Hugo> hallo');
    expect(componentText(tr, { 'chat.type.text': '%2$s von %1$s (100%%)' })).toBe('hallo von Hugo (100%)');
  });
});

