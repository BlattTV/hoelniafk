import type { EventBus } from '../core/events.js';
import { nowIso } from '../core/db.js';
import type { ChatEvent } from '../core/rules.js';
import type { ServerRewardState } from '../core/types.js';
import type { IdentityRepository } from '../identity/repository.js';

/**
 * Generic reward tracking per identity × server. Which chat lines mean
 * "stars", "eligible", "received", "waiting" or "Discord linked" is defined
 * solely by chat rules (rules.yaml). The identity-level RewardState is the
 * aggregate (sum of stars, eligible on any server).
 */
/** While the scoreboard showed the balance this recently, chat messages about stars do not change it. */
const SCOREBOARD_FRESH_MS = 15 * 60_000;

export class RewardTracker {
  /** identity:server → when the scoreboard last showed the star balance. */
  private readonly scoreboardAt = new Map<string, number>();
  /** identity:server whose balance already came from the scoreboard once (later changes count as gained). */
  private readonly scoreboardKnown = new Set<string>();

  constructor(
    private readonly repo: IdentityRepository,
    private readonly bus: EventBus,
  ) {}

  handleChatEvents(identityId: number, serverId: number, serverName: string, events: ChatEvent[], line = ''): void {
    const st = this.repo.getServerReward(identityId, serverId);
    const before = JSON.stringify(st);
    const hist: Array<[ServerRewardHistoryKind, number, string]> = [];
    // the scoreboard shows the real balance – a "+1 star" chat line would count it twice
    const fromScoreboard = Date.now() - (this.scoreboardAt.get(`${identityId}:${serverId}`) ?? 0) < SCOREBOARD_FRESH_MS;
    for (const ev of events) {
      if (fromScoreboard && (ev.kind === 'starsSet' || ev.kind === 'starsAdd')) continue;
      switch (ev.kind) {
        case 'starsSet':
          if (ev.stars !== st.stars) hist.push(['stars', ev.stars - st.stars, `${serverName}: balance ${ev.stars}`]);
          st.stars = ev.stars;
          break;
        case 'starsAdd':
          st.stars += ev.delta;
          hist.push(['stars', ev.delta, `${serverName}: +${ev.delta}`]);
          break;
        case 'eligible':
          if (st.eligible !== ev.eligible) hist.push(['eligible', 0, `${serverName}: ${ev.eligible ? 'eligible' : 'not eligible'}`]);
          st.eligible = ev.eligible;
          break;
        case 'received':
          st.received = true;
          st.waiting = false;
          hist.push(['received', 0, `${serverName}: reward received`]);
          break;
        case 'waiting':
          if (st.waiting !== true) hist.push(['waiting', 0, `${serverName}: reward waiting`]);
          st.waiting = true;
          break;
        case 'rewardDiscord':
          if (st.discordLinked !== ev.linked) hist.push(['discordLinked', 0, `${serverName}: Discord ${ev.linked ? 'linked' : 'not linked'}`]);
          st.discordLinked = ev.linked;
          break;
        case 'linked':
          if (st.discordLinked !== true) hist.push(['discordLinked', 0, `${serverName}: Discord linked`]);
          st.discordLinked = true;
          break;
        case 'unlinked':
          if (st.discordLinked !== false) hist.push(['discordLinked', 0, `${serverName}: Discord unlinked`]);
          st.discordLinked = false;
          break;
        default:
          break;
      }
    }
    if (JSON.stringify(st) === before) return;
    st.lastChange = nowIso();
    st.lastMessage = line.slice(0, 300) || st.lastMessage;
    this.repo.saveServerReward(st);
    for (const [kind, delta, reason] of hist) this.repo.addRewardHistory(identityId, serverId, kind, delta, st.stars, reason);
    this.recalc(identityId);
  }

  /**
   * The balance as the sidebar scoreboard shows it. The very first reading of an identity × server only
   * calibrates (history kind 'sync', not counted as gained); every later change is stars gained / spent.
   */
  handleScoreboard(identityId: number, serverId: number, serverName: string, stars: number, line: string): void {
    const key = `${identityId}:${serverId}`;
    this.scoreboardAt.set(key, Date.now());
    const known = this.scoreboardKnown.has(key) || this.repo.hasScoreboardHistory(identityId, serverId);
    const st = this.repo.getServerReward(identityId, serverId);
    if (known && st.stars === stars) {
      this.scoreboardKnown.add(key);
      return;
    }
    const delta = stars - st.stars;
    st.stars = stars;
    st.lastChange = nowIso();
    st.lastMessage = `Scoreboard: ${line}`.slice(0, 300);
    this.repo.saveServerReward(st);
    this.repo.addRewardHistory(identityId, serverId, known ? 'stars' : 'sync', delta, stars, `scoreboard: ${serverName}: ${line}`);
    this.scoreboardKnown.add(key);
    this.recalc(identityId);
  }

  /** Manual correction from the UI. */
  setServerState(identityId: number, serverId: number, patch: Partial<Pick<ServerRewardState, 'stars' | 'eligible' | 'received' | 'waiting' | 'discordLinked'>>): ServerRewardState {
    const st = this.repo.getServerReward(identityId, serverId);
    const oldStars = st.stars;
    Object.assign(st, patch, { lastChange: nowIso() });
    this.repo.saveServerReward(st);
    if (patch.stars !== undefined && patch.stars !== oldStars) this.repo.addRewardHistory(identityId, serverId, 'stars', patch.stars - oldStars, patch.stars, 'manual');
    this.recalc(identityId);
    return st;
  }

  recalc(identityId: number): void {
    const all = this.repo.listServerRewards(identityId);
    if (!all.length) return;
    const stars = all.reduce((a, s) => a + s.stars, 0);
    const eligible = all.some((s) => s.eligible === true);
    const cur = this.repo.getRewards(identityId);
    if (cur.stars !== stars || cur.eligible !== eligible) {
      // History is kept per server; the aggregate only updates the totals.
      this.repo.db
        .prepare(
          `INSERT INTO reward_states (identity_id, stars, eligible, last_update) VALUES (?, ?, ?, ?)
           ON CONFLICT(identity_id) DO UPDATE SET stars=excluded.stars, eligible=excluded.eligible, last_update=excluded.last_update`,
        )
        .run(identityId, stars, eligible ? 1 : 0, nowIso());
    }
    this.bus.emit({ type: 'reward.changed', identityId, data: this.repo.getRewards(identityId) });
  }
}

type ServerRewardHistoryKind = 'stars' | 'sync' | 'eligible' | 'received' | 'waiting' | 'discordLinked';
