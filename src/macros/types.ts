/**
 * Macro programs ("Scratch for Minecraft"): a trigger plus a list of blocks. Stored as JSON,
 * validated here, executed by the runtime host next to the session's bot (also on agents).
 *
 * Blocks only use normal player actions (walk, look, jump, click, chat) – nothing is sent that a
 * vanilla client could not send, and the suite itself shows nothing in the game.
 */
import { ValidationError } from '../core/errors.js';

export type MacroTrigger =
  | { type: 'manual' }
  | { type: 'spawn' }
  | { type: 'chat'; contains: string; regex?: boolean }
  | { type: 'interval'; seconds: number }
  | { type: 'time'; at: string } // HH:MM, local time, daily
  | { type: 'health'; below: number }
  | { type: 'food'; below: number }
  | { type: 'death' }
  | { type: 'playerNearby'; distance: number }; // a player comes within N blocks

export type MacroCondition =
  | { type: 'chatContains'; text: string } // last chat line (since the macro started)
  | { type: 'healthBelow'; value: number }
  | { type: 'foodBelow'; value: number }
  | { type: 'hasItem'; name: string }
  | { type: 'random'; percent: number }
  | { type: 'varCompare'; name: string; op: '<' | '<=' | '=' | '>=' | '>' | '!='; value: number }
  | { type: 'playerNearby'; distance: number }
  | { type: 'isNight' }
  | { type: 'timeBetween'; from: string; to: string }; // local time HH:MM (may wrap midnight)

export type MacroBlock =
  | { type: 'wait'; seconds: number }
  | { type: 'waitRandom'; min: number; max: number }
  | { type: 'waitChat'; text: string; timeoutSec: number }
  | { type: 'waitUntil'; cond: MacroCondition; timeoutSec: number }
  | { type: 'repeat'; times: number; body: MacroBlock[] }
  | { type: 'repeatUntil'; cond: MacroCondition; body: MacroBlock[] }
  | { type: 'forever'; body: MacroBlock[] }
  | { type: 'setVar'; name: string; value: number }
  | { type: 'changeVar'; name: string; by: number }
  | { type: 'if'; cond: MacroCondition; then: MacroBlock[]; else?: MacroBlock[] }
  | { type: 'stop' }
  | { type: 'say'; text: string }
  | { type: 'command'; text: string }
  | { type: 'move'; dir: 'forward' | 'back' | 'left' | 'right'; seconds: number; sprint?: boolean }
  | { type: 'jump'; times: number }
  | { type: 'sneak'; seconds: number }
  | { type: 'turn'; degrees: number }
  | { type: 'look'; yaw: number; pitch: number }
  | { type: 'lookAtPlayer'; distance: number }
  | { type: 'swing' }
  | { type: 'use'; seconds: number }
  | { type: 'attack'; times: number }
  | { type: 'slot'; slot: number }
  | { type: 'eat' }
  | { type: 'equip'; name: string }
  | { type: 'drop'; all: boolean }
  | { type: 'breakBlock' }
  | { type: 'log'; text: string };

export interface MacroDefinition {
  id: number;
  name: string;
  enabled: boolean;
  trigger: MacroTrigger;
  blocks: MacroBlock[];
  /** Human-like timing: waits and actions vary by ±15 % and get small pauses (default on). */
  humanize: boolean;
  /** null = every identity / server */
  identityIds: number[] | null;
  serverIds: number[] | null;
  createdAt?: string;
  updatedAt?: string;
}

/** What a host needs to run a macro (no scope data). */
export type MacroProgram = Pick<MacroDefinition, 'id' | 'name' | 'trigger' | 'blocks' | 'humanize'>;

const MAX_BLOCKS = 400;
const MAX_DEPTH = 8;

const num = (v: unknown, name: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${name} must be between ${min} and ${max}`);
  return n;
};
const str = (v: unknown, name: string, max: number, allowEmpty = false): string => {
  const s = String(v ?? '');
  if (!allowEmpty && !s.trim()) throw new ValidationError(`${name} must not be empty`);
  if (s.length > max) throw new ValidationError(`${name} is too long (max ${max})`);
  if (/[\u0000-\u001f]/.test(s)) throw new ValidationError(`${name} contains control characters`);
  return s;
};

const OPS = ['<', '<=', '=', '>=', '>', '!='] as const;
const varName = (v: unknown): string => {
  const s = String(v ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,23}$/.test(s)) throw new ValidationError('Variable names: letters, digits, _ (max 24, not starting with a digit)');
  return s;
};
const hhmm = (v: unknown): string => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw new ValidationError('Time must look like 18:30');
  return String(v);
};

export function validateTrigger(t: any): MacroTrigger {
  switch (t?.type) {
    case 'manual':
    case 'spawn':
      return { type: t.type };
    case 'chat': {
      const contains = str(t.contains, 'Chat trigger text', 200);
      if (t.regex) {
        try {
          new RegExp(contains, 'i');
        } catch {
          throw new ValidationError('Chat trigger: invalid regular expression');
        }
      }
      return { type: 'chat', contains, regex: !!t.regex };
    }
    case 'interval':
      return { type: 'interval', seconds: num(t.seconds, 'Interval', 5, 86_400) };
    case 'time':
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t.at))) throw new ValidationError('Time must look like 18:30');
      return { type: 'time', at: String(t.at) };
    case 'health':
      return { type: 'health', below: num(t.below, 'Health', 1, 20) };
    case 'food':
      return { type: 'food', below: num(t.below, 'Food', 1, 20) };
    case 'death':
      return { type: 'death' };
    case 'playerNearby':
      return { type: 'playerNearby', distance: num(t.distance, 'Distance', 1, 64) };
    default:
      throw new ValidationError('Unknown trigger');
  }
}

function validateCondition(c: any): MacroCondition {
  switch (c?.type) {
    case 'chatContains':
      return { type: 'chatContains', text: str(c.text, 'Condition text', 200) };
    case 'healthBelow':
      return { type: 'healthBelow', value: num(c.value, 'Health', 1, 20) };
    case 'foodBelow':
      return { type: 'foodBelow', value: num(c.value, 'Food', 1, 20) };
    case 'hasItem':
      return { type: 'hasItem', name: str(c.name, 'Item name', 64).toLowerCase().replace(/^minecraft:/, '') };
    case 'random':
      return { type: 'random', percent: num(c.percent, 'Chance', 0, 100) };
    case 'varCompare':
      if (!OPS.includes(c.op)) throw new ValidationError('Unknown comparison');
      return { type: 'varCompare', name: varName(c.name), op: c.op, value: num(c.value, 'Value', -1e9, 1e9) };
    case 'playerNearby':
      return { type: 'playerNearby', distance: num(c.distance, 'Distance', 1, 64) };
    case 'isNight':
      return { type: 'isNight' };
    case 'timeBetween':
      return { type: 'timeBetween', from: hhmm(c.from), to: hhmm(c.to) };
    default:
      throw new ValidationError('Unknown condition');
  }
}

/** Validates and normalises a block list (limits: 400 blocks, nesting depth 8). */
export function validateBlocks(list: any, depth = 0, count = { n: 0 }): MacroBlock[] {
  if (!Array.isArray(list)) throw new ValidationError('Blocks must be a list');
  if (depth > MAX_DEPTH) throw new ValidationError(`Blocks are nested too deeply (max ${MAX_DEPTH})`);
  return list.map((b: any): MacroBlock => {
    if (++count.n > MAX_BLOCKS) throw new ValidationError(`Too many blocks (max ${MAX_BLOCKS})`);
    switch (b?.type) {
      case 'wait':
        return { type: 'wait', seconds: num(b.seconds, 'Wait', 0.05, 86_400) };
      case 'waitRandom': {
        const min = num(b.min, 'Wait (min)', 0.05, 86_400);
        const max = num(b.max, 'Wait (max)', 0.05, 86_400);
        if (max < min) throw new ValidationError('Random wait: max must not be smaller than min');
        return { type: 'waitRandom', min, max };
      }
      case 'waitUntil':
        return { type: 'waitUntil', cond: validateCondition(b.cond), timeoutSec: num(b.timeoutSec ?? 60, 'Timeout', 1, 86_400) };
      case 'repeatUntil':
        return { type: 'repeatUntil', cond: validateCondition(b.cond), body: validateBlocks(b.body ?? [], depth + 1, count) };
      case 'setVar':
        return { type: 'setVar', name: varName(b.name), value: num(b.value, 'Value', -1e9, 1e9) };
      case 'changeVar':
        return { type: 'changeVar', name: varName(b.name), by: num(b.by, 'Change', -1e9, 1e9) };
      case 'lookAtPlayer':
        return { type: 'lookAtPlayer', distance: num(b.distance ?? 16, 'Distance', 1, 64) };
      case 'eat':
      case 'breakBlock':
        return { type: b.type };
      case 'equip':
        return { type: 'equip', name: str(b.name, 'Item name', 64).toLowerCase().replace(/^minecraft:/, '') };
      case 'drop':
        return { type: 'drop', all: !!b.all };
      case 'waitChat':
        return { type: 'waitChat', text: str(b.text, 'Wait for chat text', 200), timeoutSec: num(b.timeoutSec ?? 60, 'Timeout', 1, 86_400) };
      case 'repeat':
        return { type: 'repeat', times: Math.round(num(b.times, 'Repeat', 1, 100_000)), body: validateBlocks(b.body ?? [], depth + 1, count) };
      case 'forever': {
        const body = validateBlocks(b.body ?? [], depth + 1, count);
        return { type: 'forever', body };
      }
      case 'if':
        return { type: 'if', cond: validateCondition(b.cond), then: validateBlocks(b.then ?? [], depth + 1, count), else: validateBlocks(b.else ?? [], depth + 1, count) };
      case 'stop':
      case 'swing':
        return { type: b.type };
      case 'say':
        return { type: 'say', text: str(b.text, 'Chat text', 256) };
      case 'command':
        return { type: 'command', text: str(b.text, 'Command', 256).replace(/^\//, '') };
      case 'move':
        if (!['forward', 'back', 'left', 'right'].includes(b.dir)) throw new ValidationError('Unknown direction');
        return { type: 'move', dir: b.dir, seconds: num(b.seconds, 'Move time', 0.05, 600), sprint: !!b.sprint };
      case 'jump':
        return { type: 'jump', times: Math.round(num(b.times ?? 1, 'Jumps', 1, 1000)) };
      case 'sneak':
        return { type: 'sneak', seconds: num(b.seconds, 'Sneak time', 0.05, 600) };
      case 'turn':
        return { type: 'turn', degrees: num(b.degrees, 'Turn', -360, 360) };
      case 'look':
        return { type: 'look', yaw: num(b.yaw, 'Yaw', -180, 180), pitch: num(b.pitch, 'Pitch', -90, 90) };
      case 'use':
        return { type: 'use', seconds: num(b.seconds ?? 0.1, 'Use time', 0.05, 60) };
      case 'attack':
        return { type: 'attack', times: Math.round(num(b.times ?? 1, 'Attacks', 1, 1000)) };
      case 'slot':
        return { type: 'slot', slot: Math.round(num(b.slot, 'Hotbar slot', 1, 9)) };
      case 'log':
        return { type: 'log', text: str(b.text, 'Log text', 200) };
      default:
        throw new ValidationError(`Unknown block "${String(b?.type)}"`);
    }
  });
}

/** Loops without any wait would hammer the server: every loop body needs time (a wait, move, use …). */
export function assertLoopsTakeTime(blocks: MacroBlock[]): void {
  const takesTime = (list: MacroBlock[]): boolean =>
    list.some((b) =>
      ['wait', 'waitRandom', 'waitChat', 'waitUntil', 'move', 'sneak', 'use', 'jump', 'attack', 'eat', 'breakBlock'].includes(b.type) ||
      (b.type === 'repeat' && takesTime(b.body)) ||
      (b.type === 'repeatUntil' && takesTime(b.body)) ||
      (b.type === 'forever' && takesTime(b.body)) ||
      (b.type === 'if' && takesTime(b.then) && takesTime(b.else ?? [])),
    );
  const walk = (list: MacroBlock[]) => {
    for (const b of list) {
      if ((b.type === 'forever' || b.type === 'repeatUntil' || (b.type === 'repeat' && b.times > 20)) && !takesTime(b.body)) {
        throw new ValidationError(`"${b.type === 'forever' ? 'forever' : b.type === 'repeatUntil' ? 'repeat until' : `repeat ${b.times}×`}" needs a wait (or another timed block) inside`);
      }
      if (b.type === 'repeat' || b.type === 'forever' || b.type === 'repeatUntil') walk(b.body);
      if (b.type === 'if') {
        walk(b.then);
        walk(b.else ?? []);
      }
    }
  };
  walk(blocks);
}
