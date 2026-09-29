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
});
