/** IPC protocol between the main process and a runtime host (child process or inline). */
import type { HostStats, JavaSession, RuntimeEvent, RuntimeSessionSpec } from './types.js';

export type MainToHost =
  | { cmd: 'start'; spec: RuntimeSessionSpec }
  | { cmd: 'stop'; sessionId: string; reason: string }
  | { cmd: 'chat'; sessionId: string; text: string }
  | { cmd: 'takeover.open'; sessionId: string }
  | { cmd: 'takeover.close'; sessionId: string; reason: string }
  /** Agents only: open / close / focus the real game window for a session running on that PC. */
  | { cmd: 'game.open'; sessionId: string; spec: RuntimeSessionSpec; settings: import('../core/types.js').GameClientSettings; auth: { username: string; uuid: string } }
  | { cmd: 'game.close'; sessionId: string }
  | { cmd: 'game.show'; sessionId: string }
  | { cmd: 'auth.reply'; reqId: number; session?: JavaSession; error?: string }
  /** Macro builder: replace the session's macros / run / stop one. */
  | { cmd: 'macros.set'; sessionId: string; macros: import('../macros/types.js').MacroProgram[] }
  | { cmd: 'macro.run'; sessionId: string; macroId: number }
  | { cmd: 'macro.stop'; sessionId: string; macroId: number }
  /** Agents only: the account owner pauses / resumes this agent (like the household's pause button). */
  | { cmd: 'agent.pause' }
  /** The account owner asks the agent to update now (sessions reconnect after the restart). */
  | { cmd: 'agent.update' }
  | { cmd: 'agent.resume' }
  | { cmd: 'crash' } // test hook: simulates a runtime crash
  | { cmd: 'shutdown' };

export type HostToMain =
  | { evt: 'ready'; pid: number }
  | { evt: 'heartbeat'; stats: Omit<HostStats, 'hostId'> }
  | { evt: 'runtime'; event: RuntimeEvent }
  | { evt: 'auth.request'; reqId: number; sessionId: string }
  | { evt: 'log'; level: 'info' | 'warn' | 'error'; sessionId?: string; message: string };

export interface HostChannel {
  send(msg: HostToMain): void;
  onMessage(listener: (msg: MainToHost) => void): void;
}
