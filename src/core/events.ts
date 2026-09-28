import { EventEmitter } from 'node:events';

/** Events pushed to the UI via SSE. Payloads must never contain secrets. */
export interface SuiteEvent {
  type:
    | 'identity.changed'
    | 'session.state'
    | 'session.chat'
    | 'session.stats'
    | 'session.game'
    | 'updates.status'
    | 'agents.changed'
    | 'log'
    | 'link.state'
    | 'mail.updated'
    | 'network.checked'
    | 'auth.devicecode'
    | 'reward.changed'
    | 'audit';
  identityId?: number | null;
  data?: unknown;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: SuiteEvent): void {
    this.emitter.emit('event', event);
  }

  on(listener: (event: SuiteEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
