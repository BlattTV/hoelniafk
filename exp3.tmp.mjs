import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mc = require('minecraft-protocol');
const mineflayer = require('mineflayer');
const { installVanillaCompat } = await import('./src/minecraft/vanillaCompat.ts');
const version = '1.21.11';
const md = require('minecraft-data')(version);
const server = mc.createServer({ version, 'online-mode': false, port: 0, host: '127.0.0.1' });
await new Promise((r) => server.once('listening', r));
const port = server.socketServer.address().port;
const sysChat = (c, text) => c.write('system_chat', { content: { type: 'compound', name: '', value: { text: { type: 'string', value: text } } }, isActionBar: false });
server.on('playerJoin', async (c) => {
  c.write('login', { ...md.loginPacket, entityId: 1 });
  await new Promise((r) => setTimeout(r, 500));
  sysChat(c, 'lobby message');
  await new Promise((r) => setTimeout(r, 300));
  c.write('start_configuration', {});
  c.once('configuration_acknowledged', () => {
    c.state = 'configuration';
    c.once('finish_configuration', async () => {
      c.state = 'play';
      c.write('login', { ...md.loginPacket, entityId: 2 });
      await new Promise((r) => setTimeout(r, 500));
      sysChat(c, 'survival message');
    });
    c.write('finish_configuration', {});
  });
});
const bot = mineflayer.createBot({ host: '127.0.0.1', port, username: 'Tester', auth: 'offline', version, hideErrors: false });
installVanillaCompat(bot);
bot.on('messagestr', (t, pos) => console.log('messagestr', JSON.stringify(t), pos));
bot.on('error', (e) => console.log('error', e.message));
bot.on('end', (r) => console.log('end', r));
setTimeout(() => process.exit(0), 5000);
