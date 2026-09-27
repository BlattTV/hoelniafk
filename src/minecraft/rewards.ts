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
export class RewardTracker {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly bus: EventBus,
  ) {}

  handleChatEvents(identityId: number, serverId: number, serverName: string, events: ChatEvent[], line = ''): void {
    const st = this.repo.getServerReward(identityId, serverId);
    const before = JSON.stringify(st);
    const hist: Array<[ServerRewardHistoryKind, number, string]> = [];
    for (const ev of events) {
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

type ServerRewardHistoryKind = 'stars' | 'eligible' | 'received' | 'waiting' | 'discordLinked';
