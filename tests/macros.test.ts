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

describe('macro builder – extended blocks', () => {
  class Bot2 extends Bot {
    username = 'Tester';
    time = { timeOfDay: 18000 };
    heldItem: any = null;
    calls: string[] = [];
    entities: any[] = [];
    override entity: any = { yaw: 0, pitch: 0, position: { x: 10.4, y: 64, z: -3.6, distanceTo: (o: any) => Math.hypot(o.x - 10.4, o.y - 64, o.z + 3.6), offset: () => ({}) } };
    override inventory = { items: () => [{ name: 'bread', type: 1 }, { name: 'stone', type: 2 }] };
    nearestEntity(f: (e: any) => boolean) {
      return this.entities.find(f) ?? null;
    }
    async consume() {
      this.calls.push('eat');
    }
    async equip(item: any) {
      this.heldItem = item;
      this.calls.push(`equip:${item.name}`);
    }
    async toss(type: number, _m: any, n: number) {
      this.calls.push(`toss:${type}x${n}`);
    }
    async tossStack(item: any) {
      this.calls.push(`tossStack:${item.name}`);
    }
    blockAtCursor() {
      return { name: 'dirt' };
    }
    async dig(block: any) {
      this.calls.push(`dig:${block.name}`);
    }
    async lookAt() {
      this.calls.push('lookAt');
    }
  }
  const player = (d: number) => ({ type: 'player', username: 'Friend', height: 1.8, position: { x: 10.4 + d, y: 64, z: -3.6, offset: () => ({}), distanceTo: () => d } });

  it('variables, repeat until, placeholders, wait until and random waits', async () => {
    const bot = new Bot2();
    const events: MacroEvent[] = [];
    const e = new MacroEngine(bot, (x) => events.push(x), () => false, () => 0.5);
    e.set([prog([
      { type: 'setVar', name: 'counter', value: 0 },
      { type: 'repeatUntil', cond: { type: 'varCompare', name: 'counter', op: '>=', value: 3 }, body: [{ type: 'changeVar', name: 'counter', by: 1 }, { type: 'wait', seconds: 0.05 }] },
      { type: 'say', text: 'round {counter} at {x} {y} {z}, health {health}, I am {name}' },
      { type: 'waitRandom', min: 0.05, max: 0.1 },
      { type: 'waitUntil', cond: { type: 'isNight' }, timeoutSec: 2 },
      { type: 'if', cond: { type: 'timeBetween', from: '00:00', to: '23:59' }, then: [{ type: 'log', text: 'var {var:counter}' }] },
    ])]);
    e.run(1);
    await until(() => events.some((x) => x.status === 'finished' || x.status === 'error'));
    expect(events.find((x) => x.status === 'error')).toBeUndefined();
    expect(e.vars.get('counter')).toBe(3);
    expect(bot.sent).toEqual(['round 3 at 10 64 -4, health 20, I am Tester']);
    expect(events.find((x) => x.status === 'log')?.message).toBe('var 3');
  });

  it('actions: hold item, eat, drop, break block, look at a player', async () => {
    const bot = new Bot2();
    bot.entities = [player(5)];
    const events: MacroEvent[] = [];
    const e = new MacroEngine(bot, (x) => events.push(x));
    e.set([prog([
      { type: 'equip', name: 'minecraft:bread' },
      { type: 'eat' },
      { type: 'drop', all: false },
      { type: 'drop', all: true },
      { type: 'breakBlock' },
      { type: 'lookAtPlayer', distance: 10 },
    ])]);
    e.run(1);
    await until(() => events.some((x) => x.status === 'finished' || x.status === 'error'));
    expect(bot.calls).toEqual(['equip:bread', 'eat', 'toss:1x1', 'tossStack:bread', 'dig:dirt', 'lookAt']);
    // a missing item is a clear error
    e.set([prog([{ type: 'equip', name: 'diamond' }])]);
    e.run(1);
    await until(() => events.some((x) => x.status === 'error'));
    expect(events.find((x) => x.status === 'error')?.message).toMatch(/No diamond in the inventory/);
  });

  it('triggers: food below, death, a player coming near (edge only)', async () => {
    const bot = new Bot2();
    const e = new MacroEngine(bot, () => undefined);
    e.set([
      { ...prog([{ type: 'say', text: 'hungry' }], { type: 'food', below: 6 }), id: 1 },
      { ...prog([{ type: 'say', text: 'died' }], { type: 'death' }), id: 2 },
      { ...prog([{ type: 'say', text: 'hi {name}' }], { type: 'playerNearby', distance: 8 }), id: 3 },
    ]);
    bot.food = 4;
    bot.emit('health');
    bot.emit('health');
    bot.emit('death');
    bot.entities = [player(3)];
    await until(() => bot.sent.includes('hi Tester'), 4000);
    await new Promise((r) => setTimeout(r, 2200)); // still near → no second greeting
    expect(bot.sent.sort()).toEqual(['died', 'hi Tester', 'hungry']);
    e.dispose();
  });

  it('validation of the new blocks', () => {
    expect(() => validateBlocks([{ type: 'setVar', name: '1abc', value: 1 }])).toThrow(/Variable names/);
    expect(() => validateBlocks([{ type: 'waitRandom', min: 5, max: 2 }])).toThrow(/max must not be smaller/);
    expect(() => validateBlocks([{ type: 'if', cond: { type: 'varCompare', name: 'x', op: '~', value: 1 }, then: [] }])).toThrow(/Unknown comparison/);
    expect(() => validateBlocks([{ type: 'if', cond: { type: 'timeBetween', from: '25:00', to: '10:00' }, then: [] }])).toThrow(/18:30/);
    expect(() => assertLoopsTakeTime(validateBlocks([{ type: 'repeatUntil', cond: { type: 'isNight' }, body: [{ type: 'say', text: 'x' }] }]))).toThrow(/repeat until/);
    expect(() => validateTrigger({ type: 'playerNearby', distance: 500 })).toThrow(/Distance/);
    expect(validateBlocks([{ type: 'equip', name: 'minecraft:Bread' }])).toEqual([{ type: 'equip', name: 'bread' }]);
  });
});
