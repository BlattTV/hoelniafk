/**
 * Stars from the sidebar scoreboard: what the player sees (modern scoreboard plugins: per-line display
 * texts without numbers, team prefixes, classic "label + score"), the shipped rules, the reward
 * history (first reading only calibrates) and the statistics (gained per 24 h / 7 / 30 days).
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { loadRules, parseScoreboard } from '../src/core/rules.js';
import { watchSidebar } from '../src/runtime/host/sidebar.js';
import { starStats } from '../src/minecraft/starStats.js';
import { createTestSuite, waitFor } from './helpers.js';

const require = createRequire(import.meta.url);
const rules = loadRules('config/rules.yaml');
const stars = (lines: Array<{ text: string; value?: number; hidden?: boolean }>) =>
  parseScoreboard(rules, ['hoelni-rewards'], lines.map((l, i) => ({ value: 15 - i, ...l })))?.stars ?? null;

describe('star balance in the sidebar (shipped rules)', () => {
  it('reads the usual layouts', () => {
    expect(stars([{ text: 'HugoSMP', hidden: true }, { text: '§eSterne: §61.234', hidden: true }, { text: 'Online: 5', hidden: true }])).toBe(1234);
    expect(stars([{ text: 'Rang: Spieler' }, { text: '⭐ 87' }])).toBe(87);
    expect(stars([{ text: '» 1,500 Stars' }])).toBe(1500);
    // label in one line, the number below
    expect(stars([{ text: '⭐ Sterne', hidden: true }, { text: ' 42', hidden: true }, { text: 'Online: 3', hidden: true }])).toBe(42);
    // classic scoreboard: the label is the entry, the number is the score
    expect(stars([{ text: 'Sterne:', value: 950 }])).toBe(950);
    // no stars on the sidebar → nothing (never the online count or the line numbers)
    expect(stars([{ text: 'Online: 5' }, { text: 'play.hoelni.de' }, { text: 'Kills', value: 3 }])).toBeNull();
  });
});

describe('sidebar as the player sees it (real protocol, 1.21.4)', () => {
  it('display texts without numbers and team prefixes', async () => {
    const version = '1.21.4';
    const mc = require('minecraft-protocol');
    const mineflayer = require('mineflayer');
    const nbt = require('prismarine-nbt');
    const server = mc.createServer({ version, 'online-mode': false, port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const md = require('minecraft-data')(version);
    let sc: any;
    server.on('playerJoin', (c: any) => {
      sc = c;
      c.write('login', { ...md.loginPacket, entityId: 1 });
    });
    const bot = mineflayer.createBot({ version, host: '127.0.0.1', port: server.socketServer.address().port, username: 'Board01', auth: 'offline' });
    const seen: any[] = [];
    const off = watchSidebar(bot, (s) => seen.push(s), 50);
    try {
      await waitFor(() => !!sc && bot._client.state === 'play', 8000, 'in play');
      const text = (t: string, extra?: any[]) => nbt.comp({ text: nbt.string(t), ...(extra ? { extra: nbt.list(nbt.comp(extra)) } : {}) });
      sc.write('scoreboard_objective', { name: 'hugo', action: 0, displayText: text('HugoSMP'), type: 0, number_format: 0 });
      sc.write('scoreboard_display_objective', { position: 1, name: 'hugo' });
      sc.write('scoreboard_score', { itemName: 'l1', scoreName: 'hugo', value: 3, display_name: text('Sterne: ', [{ text: nbt.string('1.234'), color: nbt.string('gold') }]) });
      sc.write('scoreboard_score', { itemName: 'l2', scoreName: 'hugo', value: 2, display_name: text('Online: 5') });
      // a line drawn by a team prefix (older plugins): entry "§1", prefix "Spielzeit: ", suffix "3h"
      sc.write('teams', { team: 't1', mode: 0, name: text('t1'), friendlyFire: 0, nameTagVisibility: 'always', collisionRule: 'always', formatting: 21, prefix: text('Spielzeit: '), suffix: text('3h'), players: ['§1'] });
      sc.write('scoreboard_score', { itemName: '§1', scoreName: 'hugo', value: 1 });
      await waitFor(() => seen.at(-1)?.lines.length === 3, 5000, 'sidebar lines');
      const last = seen.at(-1);
      expect(last.title).toBe('HugoSMP');
      expect(last.lines).toEqual([
        { text: 'Sterne: 1.234', value: 3, hidden: true },
        { text: 'Online: 5', value: 2, hidden: true },
        { text: 'Spielzeit: 3h', value: 1, hidden: true },
      ]);
      expect(parseScoreboard(rules, ['hoelni-rewards'], last.lines)?.stars).toBe(1234);
      // the balance changes: only that line is sent again
      sc.write('scoreboard_score', { itemName: 'l1', scoreName: 'hugo', value: 3, display_name: text('Sterne: 1.235') });
      await waitFor(() => seen.at(-1)?.lines[0].text === 'Sterne: 1.235', 5000, 'update');
    } finally {
      off();
      bot.end();
      server.close();
    }
  }, 30_000);
});

describe('reward history and statistics', () => {
  it('first reading calibrates, later changes count; chat "+1" is not counted twice', async () => {
    const t = await createTestSuite();
    const s = t.suite;
    const srv = s.repo.upsertServer({ name: 'HugoSMP', host: 'play.hoelni.de', port: 25565 });
    const id = s.identities.create({ label: 'Hugo' }).identity.id;
    s.repo.upsertMinecraft(id, { username: 'Hugo', authType: 'offline' });
    s.rewards.handleScoreboard(id, srv.id, 'HugoSMP', 500, 'Sterne: 500');
    expect(s.repo.getRewards(id).stars).toBe(500);
    s.rewards.handleScoreboard(id, srv.id, 'HugoSMP', 503, 'Sterne: 503');
    // the chat line about the same star arrives too – the scoreboard already counted it
    s.rewards.handleChatEvents(id, srv.id, 'HugoSMP', [{ kind: 'starsAdd', ruleSet: 'hoelni-rewards', delta: 1 }], 'Du hast 1 Star erhalten!');
    expect(s.repo.getRewards(id).stars).toBe(503);
    s.rewards.handleScoreboard(id, srv.id, 'HugoSMP', 501, 'Sterne: 501'); // spent 2
    const st = starStats(s.repo, [{ id, name: 'Hugo', stars: s.repo.getRewards(id).stars, online: true }]);
    expect(st.total).toBe(501);
    expect(st.gained).toEqual({ h24: 3, d7: 3, d30: 3, d365: 3 }); // 500 → 503; the calibration does not count
    expect(st.spent.h24).toBe(2);
    expect(st.hourly.at(-1)!.gained).toBe(3);
    expect(st.daily.at(-1)!.gained).toBe(3);
    expect(st.daily).toHaveLength(30);
    expect(st.perIdentity[0]).toMatchObject({ id, h24: 3, d7: 3 });
    // after a restart the balance is known as coming from the scoreboard: changes still count
    const again = new (s.rewards.constructor as any)(s.repo, s.bus);
    again.handleScoreboard(id, srv.id, 'HugoSMP', 510, 'Sterne: 510');
    expect(starStats(s.repo, [{ id, name: 'Hugo', stars: 510, online: true }]).gained.h24).toBe(12);
    await s.shutdown();
  });
});
