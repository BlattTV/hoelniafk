/**
 * Runs macro programs next to a session's bot (runtime host – also on agents).
 *
 *  - triggers: manual, session online (spawn), chat line, interval, daily time, health below
 *  - one run per macro at a time; every run can be stopped
 *  - pauses while the real game controls the session (live takeover) – the player has priority
 *  - human timing (optional): waits/actions vary by ±15 %, small pauses between actions
 *  - only normal player actions through the bot's regular API; the suite shows nothing in-game
 */
import { createRequire } from 'node:module';
import type { MacroBlock, MacroCondition, MacroProgram } from './types.js';

const require = createRequire(import.meta.url);

export type MacroStatus = 'started' | 'finished' | 'stopped' | 'error' | 'log';
export interface MacroEvent {
  macroId: number;
  status: MacroStatus;
  message?: string;
}

class Stopped extends Error {}

interface RunCtx {
  stopped: boolean;
  chat: string[];
  wake: Array<() => void>;
}

export class MacroEngine {
  private programs: MacroProgram[] = [];
  private readonly runs = new Map<number, RunCtx>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly offs: Array<() => void> = [];
  private lastTimeKey = '';
  private healthArmed = new Set<number>();
  private disposed = false;

  constructor(
    private readonly bot: any,
    private readonly emit: (e: MacroEvent) => void,
    private readonly isPaused: () => boolean = () => false,
    private readonly random: () => number = Math.random,
  ) {}

  /** Installs (or replaces) the macros of this session and their triggers. */
  set(programs: MacroProgram[]): void {
    this.clearTriggers();
    this.programs = programs;
    const onChat = (text: string, position?: string) => {
      if (position === 'game_info') return;
      const line = String(text);
      for (const ctx of this.runs.values()) {
        ctx.chat.push(line);
        if (ctx.chat.length > 200) ctx.chat.shift();
        for (const w of ctx.wake.splice(0)) w();
      }
      for (const p of this.programs) {
        if (p.trigger.type !== 'chat') continue;
        const hit = p.trigger.regex ? new RegExp(p.trigger.contains, 'i').test(line) : line.toLowerCase().includes(p.trigger.contains.toLowerCase());
        if (hit) this.run(p.id, `chat: ${line.slice(0, 80)}`);
      }
    };
    this.bot.on('messagestr', onChat);
    this.offs.push(() => this.bot.removeListener('messagestr', onChat));

    const onHealth = () => {
      for (const p of this.programs) {
        if (p.trigger.type !== 'health') continue;
        const h = Number(this.bot.health ?? 20);
        if (h < p.trigger.below && !this.healthArmed.has(p.id)) {
          this.healthArmed.add(p.id);
          this.run(p.id, `health ${h}`);
        } else if (h >= p.trigger.below) this.healthArmed.delete(p.id);
      }
    };
    this.bot.on('health', onHealth);
    this.offs.push(() => this.bot.removeListener('health', onHealth));

    for (const p of this.programs) {
      if (p.trigger.type === 'interval') {
        const t = setInterval(() => this.run(p.id, 'interval'), p.trigger.seconds * 1000);
        t.unref?.();
        this.timers.push(t);
      }
    }
    if (this.programs.some((p) => p.trigger.type === 'time')) {
      const t = setInterval(() => this.checkTime(), 15_000);
      t.unref?.();
      this.timers.push(t);
    }
  }

  /** Session is in the world: "when online" macros start. */
  spawned(): void {
    for (const p of this.programs) if (p.trigger.type === 'spawn') this.run(p.id, 'session online');
  }

  private checkTime(now = new Date()): void {
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const key = `${now.toDateString()} ${hhmm}`;
    if (key === this.lastTimeKey) return;
    this.lastTimeKey = key;
    for (const p of this.programs) if (p.trigger.type === 'time' && p.trigger.at === hhmm) this.run(p.id, `time ${hhmm}`);
  }

  isRunning(id: number): boolean {
    return this.runs.has(id);
  }

  run(id: number, reason = 'manual'): boolean {
    if (this.disposed || this.runs.has(id)) return false;
    const p = this.programs.find((x) => x.id === id);
    if (!p) return false;
    const ctx: RunCtx = { stopped: false, chat: [], wake: [] };
    this.runs.set(id, ctx);
    this.emit({ macroId: id, status: 'started', message: reason });
    const physics = this.bot.physicsEnabled;
    void this.exec(p, p.blocks, ctx)
      .then(() => this.emit({ macroId: id, status: 'finished' }))
      .catch((e) => this.emit({ macroId: id, status: e instanceof Stopped ? 'stopped' : 'error', message: e instanceof Stopped ? undefined : (e as Error).message }))
      .finally(() => {
        this.runs.delete(id);
        this.releaseControls();
        if (physics !== undefined && !this.runs.size) this.bot.physicsEnabled = physics;
      });
    return true;
  }

  stop(id: number): void {
    const ctx = this.runs.get(id);
    if (!ctx) return;
    ctx.stopped = true;
    for (const w of ctx.wake.splice(0)) w();
  }

  stopAll(): void {
    for (const id of [...this.runs.keys()]) this.stop(id);
  }

  dispose(): void {
    this.disposed = true;
    this.stopAll();
    this.clearTriggers();
  }

  private clearTriggers(): void {
    for (const t of this.timers.splice(0)) clearInterval(t);
    for (const off of this.offs.splice(0)) off();
    this.healthArmed.clear();
  }

  // ------------------------------------------------------------------ interpreter

  private jitter(ms: number, p: MacroProgram): number {
    return p.humanize ? ms * (0.85 + this.random() * 0.3) : ms;
  }

  /** Waits ms (cancellable); the time spent while the player controls the session does not count. */
  private async sleep(ms: number, ctx: RunCtx): Promise<void> {
    let left = ms;
    while (left > 0) {
      if (ctx.stopped) throw new Stopped();
      const step = Math.min(left, 250);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, step);
        ctx.wake.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
      if (!this.isPaused()) left -= step;
    }
    if (ctx.stopped) throw new Stopped();
  }

  private async ready(ctx: RunCtx, p: MacroProgram): Promise<void> {
    while (this.isPaused()) await this.sleep(250, ctx).catch((e) => { throw e; });
    if (ctx.stopped) throw new Stopped();
    if (p.humanize) await this.sleep(80 + this.random() * 140, ctx);
  }

  private check(c: MacroCondition, ctx: RunCtx): boolean {
    switch (c.type) {
      case 'chatContains':
        return ctx.chat.some((l) => l.toLowerCase().includes(c.text.toLowerCase()));
      case 'healthBelow':
        return Number(this.bot.health ?? 20) < c.value;
      case 'foodBelow':
        return Number(this.bot.food ?? 20) < c.value;
      case 'hasItem':
        return (this.bot.inventory?.items?.() ?? []).some((i: any) => i.name === c.name);
      case 'random':
        return this.random() * 100 < c.percent;
    }
  }

  private async exec(p: MacroProgram, blocks: MacroBlock[], ctx: RunCtx): Promise<void> {
    const bot = this.bot;
    for (const b of blocks) {
      if (ctx.stopped) throw new Stopped();
      switch (b.type) {
        case 'wait':
          await this.sleep(this.jitter(b.seconds * 1000, p), ctx);
          break;
        case 'waitChat': {
          const deadline = Date.now() + b.timeoutSec * 1000;
          while (!ctx.chat.some((l) => l.toLowerCase().includes(b.text.toLowerCase()))) {
            if (Date.now() > deadline) throw new Error(`No chat line with "${b.text}" within ${b.timeoutSec}s`);
            await this.sleep(Math.min(500, deadline - Date.now() + 1), ctx);
          }
          break;
        }
        case 'repeat':
          for (let i = 0; i < b.times; i++) {
            await this.exec(p, b.body, ctx);
            await this.sleep(20, ctx); // never a tight loop
          }
          break;
        case 'forever':
          for (;;) {
            await this.exec(p, b.body, ctx);
            await this.sleep(20, ctx);
          }
        case 'if':
          await this.exec(p, this.check(b.cond, ctx) ? b.then : b.else ?? [], ctx);
          break;
        case 'stop':
          throw new Stopped();
        case 'say':
          await this.ready(ctx, p);
          bot.chat(b.text);
          break;
        case 'command':
          await this.ready(ctx, p);
          bot.chat(`/${b.text}`);
          break;
        case 'move':
          await this.ready(ctx, p);
          bot.physicsEnabled = true;
          if (b.sprint) bot.setControlState('sprint', true);
          bot.setControlState(b.dir, true);
          try {
            await this.sleep(this.jitter(b.seconds * 1000, p), ctx);
          } finally {
            bot.setControlState(b.dir, false);
            if (b.sprint) bot.setControlState('sprint', false);
          }
          break;
        case 'jump':
          bot.physicsEnabled = true;
          for (let i = 0; i < b.times; i++) {
            await this.ready(ctx, p);
            bot.setControlState('jump', true);
            await this.sleep(this.jitter(260, p), ctx).finally(() => bot.setControlState('jump', false));
            await this.sleep(this.jitter(340, p), ctx);
          }
          break;
        case 'sneak':
          await this.ready(ctx, p);
          bot.setControlState('sneak', true);
          await this.sleep(this.jitter(b.seconds * 1000, p), ctx).finally(() => bot.setControlState('sneak', false));
          break;
        case 'turn':
          await this.ready(ctx, p);
          await bot.look((bot.entity?.yaw ?? 0) - (b.degrees * Math.PI) / 180, bot.entity?.pitch ?? 0, false);
          break;
        case 'look': {
          await this.ready(ctx, p);
          const conv = require('mineflayer/lib/conversions');
          await bot.look(conv.fromNotchianYaw(b.yaw), conv.fromNotchianPitch(b.pitch), false);
          break;
        }
        case 'swing':
          await this.ready(ctx, p);
          bot.swingArm?.();
          break;
        case 'use':
          await this.ready(ctx, p);
          bot.activateItem?.();
          await this.sleep(this.jitter(b.seconds * 1000, p), ctx).finally(() => bot.deactivateItem?.());
          break;
        case 'attack':
          for (let i = 0; i < b.times; i++) {
            await this.ready(ctx, p);
            const target = bot.nearestEntity?.((e: any) => e !== bot.entity && e.type !== 'player' && e.position && bot.entity && e.position.distanceTo(bot.entity.position) < 3.5);
            if (target) bot.attack(target);
            else bot.swingArm?.();
            await this.sleep(this.jitter(650, p), ctx); // attack cooldown like a player
          }
          break;
        case 'slot':
          await this.ready(ctx, p);
          bot.setQuickBarSlot?.(b.slot - 1);
          break;
        case 'log':
          this.emit({ macroId: p.id, status: 'log', message: b.text });
          break;
      }
    }
  }

  private releaseControls(): void {
    try {
      for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) this.bot.setControlState?.(c, false);
      this.bot.deactivateItem?.();
    } catch {
      /* bot gone */
    }
  }
}
