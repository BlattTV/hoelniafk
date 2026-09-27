import type { EventBus } from '../core/events.js';
import type { ChatEvent } from '../core/rules.js';
import type { IdentityRepository } from '../identity/repository.js';

/** Applies reward-related chat events (configured in rules.yaml) to the identity's RewardState. */
export class RewardTracker {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly bus: EventBus,
  ) {}

  handleChatEvents(identityId: number, serverName: string, events: ChatEvent[]): void {
    for (const ev of events) {
      if (ev.kind === 'starsSet') {
        this.repo.setRewards(identityId, { stars: ev.stars }, `${serverName}: balance`);
      } else if (ev.kind === 'starsAdd') {
        const cur = this.repo.getRewards(identityId);
        this.repo.setRewards(identityId, { stars: cur.stars + ev.delta }, `${serverName}: +${ev.delta}`);
      } else if (ev.kind === 'eligible') {
        this.repo.setRewards(identityId, { eligible: ev.eligible }, `${serverName}: eligibility`);
      } else continue;
      this.bus.emit({ type: 'reward.changed', identityId, data: this.repo.getRewards(identityId) });
    }
  }
}
