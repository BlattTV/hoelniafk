/** IPC protocol between the main process and a runtime host (child process or inline). */
import type { ControlInput, HostStats, InventoryItem, JavaSession, RuntimeEvent, RuntimeSessionSpec } from './types.js';

export type MainToHost =
  | { cmd: 'start'; spec: RuntimeSessionSpec }
  | { cmd: 'stop'; sessionId: string; reason: string }
  | { cmd: 'chat'; sessionId: string; text: string }
  | { cmd: 'control'; sessionId: string; input: ControlInput }
  | { cmd: 'inventory'; reqId: number; sessionId: string }
  | { cmd: 'view.attach'; sessionId: string; viewId: string }
  | { cmd: 'view.detach'; viewId: string }
  | { cmd: 'view.in'; viewId: string; event: string; args: unknown[] }
  | { cmd: 'setViewOpen'; sessionId: string; open: boolean }
  | { cmd: 'auth.reply'; reqId: number; session?: JavaSession; error?: string }
  | { cmd: 'crash' } // test hook: simulates a runtime crash
  | { cmd: 'shutdown' };

export type HostToMain =
  | { evt: 'ready'; pid: number }
  | { evt: 'heartbeat'; stats: Omit<HostStats, 'hostId'> }
  | { evt: 'runtime'; event: RuntimeEvent }
  | { evt: 'auth.request'; reqId: number; sessionId: string }
  | { evt: 'inventory.reply'; reqId: number; items?: InventoryItem[]; error?: string }
  | { evt: 'log'; level: 'info' | 'warn' | 'error'; sessionId?: string; message: string };

export interface HostChannel {
  send(msg: HostToMain): void;
  onMessage(listener: (msg: MainToHost) => void): void;
}
