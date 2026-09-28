import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { MacroEngine, type MacroEvent } from '../src/macros/engine.js';
import { assertLoopsTakeTime, validateBlocks, validateTrigger, type MacroProgram } from '../src/macros/types.js';

class Bot extends EventEmitter {
  sent: string[] = [];
  controls: string[] = [];
  health = 20;
  food = 20;
  physicsEnabled = false;
  entity = { yaw: 0, pitch: 0 };
  inventory = { items: () => [{ name: 'bread' }] };
  chat(t: string) {
    this.sent.push(t);
  }
  setControlState(c: string, on: boolean) {
    this.controls.push(`${c}:${on}`);
  }
  swingArm() {
    this.sent.push('<swing>');
  }
  async look(yaw: number) {
    this.entity.yaw = yaw;
  }
}

const prog = (blocks: any[], trigger: any = { type: 'manual' }): MacroProgram => ({ id: 1, name: 't', trigger, blocks: validateBlocks(blocks), humanize: false });
const until = async (cond: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('macro engine', () => {
  it('runs blocks in order: repeat, if/else, wait, command', async () => {
    const bot = new Bot();
    const events: MacroEvent[] = [];
    const e = new MacroEngine(bot, (x) => events.push(x));
    e.set([prog([
      { type: 'repeat', times: 3, body: [{ type: 'say', text: 'hi' }, { type: 'wait', seconds: 0.05 }] },
      { type: 'if', cond: { type: 'hasItem', name: 'minecraft:bread' }, then: [{ type: 'command', text: '/eat' }], else: [{ type: 'say', text: 'no bread' }] },
      { type: 'if', cond: { type: 'healthBelow', value: 5 }, then: [{ type: 'say', text: 'low' }] },
      { type: 'move', dir: 'forward', seconds: 0.05, sprint: true },
      { type: 'log', text: 'done' },
    ])]);
    expect(e.run(1)).toBe(true);
    expect(e.run(1)).toBe(false); // one run at a time
    await until(() => events.some((x) => x.status === 'finished'));
    expect(bot.sent).toEqual(['hi', 'hi', 'hi', '/eat']);
    expect(bot.controls).toContain('forward:true');
    expect(bot.controls).toContain('forward:false');
    expect(events.map((x) => x.status)).toEqual(['started', 'log', 'finished']);
    expect(bot.physicsEnabled).toBe(false); // restored after the run
  });

  it('triggers: chat line, "session online", health below (edge only), stop', async () => {
    const bot = new Bot();
    const events: MacroEvent[] = [];
    const e = new MacroEngine(bot, (x) => events.push(x));
    e.set([
      { ...prog([{ type: 'command', text: 'link' }], { type: 'chat', contains: 'link your account' }), id: 1 },
      { ...prog([{ type: 'say', text: 'online!' }], { type: 'spawn' }), id: 2 },
      { ...prog([{ type: 'say', text: 'heal' }], { type: 'health', below: 6 }), id: 3 },
      { ...prog([{ type: 'forever', body: [{ type: 'wait', seconds: 0.05 }] }]), id: 4 },
    ]);
    bot.emit('messagestr', 'Please Link your account using code X1');
    e.spawned();
    bot.health = 4;
    bot.emit('health');
    bot.emit('health'); // still low – no second run
    await until(() => bot.sent.length === 3);
    expect(bot.sent.sort()).toEqual(['/link', 'heal', 'online!']);
    e.run(4);
    await new Promise((r) => setTimeout(r, 120));
    expect(e.isRunning(4)).toBe(true);
    e.stop(4);
    await until(() => events.some((x) => x.macroId === 4 && x.status === 'stopped'));
    e.dispose();
  });

  it('pauses while the real game controls the session', async () => {
    const bot = new Bot();
    let paused = true;
    const events: MacroEvent[] = [];
    const e = new MacroEngine(bot, (x) => events.push(x), () => paused);
    e.set([prog([{ type: 'say', text: 'after pause' }])]);
    e.run(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(bot.sent).toEqual([]);
    paused = false;
    await until(() => bot.sent.length === 1);
  });

  it('humanized timing varies waits within ±15 %', async () => {
    const bot = new Bot();
    const events: MacroEvent[] = [];
    const e = new MacroEngine(bot, (x) => events.push(x), () => false, () => 1); // max jitter
    e.set([{ ...prog([{ type: 'wait', seconds: 0.3 }]), humanize: true }]);
    const t = Date.now();
    e.run(1);
    await until(() => events.some((x) => x.status === 'finished'));
    const took = Date.now() - t;
    expect(took).toBeGreaterThanOrEqual(330);
    expect(took).toBeLessThan(700);
  });
});

describe('macro validation', () => {
  it('rejects unknown blocks, bad values, deep nesting and loops without time', () => {
    expect(() => validateBlocks([{ type: 'exec', cmd: 'rm' }])).toThrow(/Unknown block/);
    expect(() => validateBlocks([{ type: 'wait', seconds: -1 }])).toThrow(/Wait/);
    expect(() => validateBlocks([{ type: 'say', text: 'x'.repeat(300) }])).toThrow(/too long/);
    let deep: any[] = [{ type: 'swing' }];
    for (let i = 0; i < 10; i++) deep = [{ type: 'repeat', times: 2, body: deep }];
    expect(() => validateBlocks(deep)).toThrow(/nested too deeply/);
    expect(() => assertLoopsTakeTime(validateBlocks([{ type: 'forever', body: [{ type: 'say', text: 'spam' }] }]))).toThrow(/needs a wait/);
    expect(() => assertLoopsTakeTime(validateBlocks([{ type: 'forever', body: [{ type: 'say', text: 'ok' }, { type: 'wait', seconds: 5 }] }]))).not.toThrow();
    expect(() => validateTrigger({ type: 'time', at: '25:00' })).toThrow(/18:30/);
    expect(() => validateTrigger({ type: 'chat', contains: '(', regex: true })).toThrow(/regular expression/);
    expect(validateBlocks([{ type: 'command', text: '/spawn' }])).toEqual([{ type: 'command', text: 'spawn' }]);
  });
});
