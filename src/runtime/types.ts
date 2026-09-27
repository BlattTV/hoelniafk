/**
 * Minecraft runtime abstraction.
 *
 *   MinecraftRuntime
 *   └── MineflayerRuntime      lightweight protocol client (mineflayer) running in
 *                              supervised host processes; the interactive 3D view is
 *                              attached to the SAME running session on demand.
 *
 * The SessionManager (per session: start/stop/reconnect/sendChat/getChat/getState/
 * openInteractiveView/hideInteractiveView) only talks to this interface.
 */
import type { NetworkProfile } from '../core/types.js';

export interface RuntimeNetwork {
  profile: NetworkProfile | null;
  secret: { password: string } | null;
}

export interface RuntimeSessionSpec {
  sessionId: string;
  identityId: number;
  server: { id: number; name: string; host: string; port: number; version: string | null };
  /** Offline username, or the profile name expected for Microsoft auth. */
  username: string;
  auth: 'offline' | 'microsoft';
  network: RuntimeNetwork;
  afk: { enabled: boolean; action: 'none' | 'look' | 'swing' | 'jump'; intervalSec: number };
  /** Lightweight mode: physics disabled while the interactive view is hidden (unless AFK needs it). */
  lightweight: boolean;
  viewDistance: 'tiny' | 'short' | 'normal' | 'far';
}

/** Serializable Minecraft Java session obtained by the main process (tokens never leave memory). */
export interface JavaSession {
  accessToken: string;
  profile: { id: string; name: string };
  profileKeys: null | {
    publicPEM: string;
    privatePEM: string;
    signature: string; // base64
    signatureV2: string; // base64
    expiresOn: string;
  };
}

export type RuntimeSessionPhase = 'CONNECTING' | 'AUTHENTICATING' | 'ONLINE';

export interface SessionStats {
  bytesIn: number;
  bytesOut: number;
  ping: number | null;
  health: number | null;
  food: number | null;
  position: { x: number; y: number; z: number } | null;
  dimension: string | null;
  physics: boolean;
  viewOpen: boolean;
  version: string | null;
}

export type RuntimeEvent =
  | { type: 'phase'; sessionId: string; phase: RuntimeSessionPhase }
  | { type: 'spawned'; sessionId: string; username: string; uuid: string | null; version: string | null }
  | { type: 'chat'; sessionId: string; text: string; ts: string }
  | { type: 'ended'; sessionId: string; reason: string; kicked: boolean; error: string | null }
  | { type: 'stats'; sessionId: string; stats: SessionStats }
  | { type: 'view'; viewId: string; event: string; args: unknown[] };

export type ControlInput =
  | { kind: 'state'; control: 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'sneak'; value: boolean }
  | { kind: 'look'; yaw: number; pitch: number }
  | { kind: 'lookDelta'; dYaw: number; dPitch: number }
  | { kind: 'attack' }
  | { kind: 'use' }
  | { kind: 'dig' }
  | { kind: 'stopDig' }
  | { kind: 'place' }
  | { kind: 'hotbar'; slot: number }
  | { kind: 'clearControls' };

export interface InventoryItem {
  slot: number;
  name: string;
  displayName: string;
  count: number;
}

export interface HostStats {
  hostId: string;
  pid: number;
  rss: number;
  heapUsed: number;
  cpuPercent: number;
  eventLoopLagMs: number;
  sessions: number;
  threads: number | null;
  uptimeSec: number;
}

export interface RuntimeStats {
  kind: string;
  hosts: HostStats[];
}

export interface MinecraftRuntime {
  readonly kind: 'mineflayer';
  startSession(spec: RuntimeSessionSpec): Promise<void>;
  stopSession(sessionId: string, reason?: string): Promise<void>;
  sendChat(sessionId: string, text: string): Promise<void>;
  control(sessionId: string, input: ControlInput): Promise<void>;
  inventory(sessionId: string): Promise<InventoryItem[]>;
  /** Switches a running session into interactive mode (physics on, AFK paused) – no reconnect. */
  openInteractiveView(sessionId: string): Promise<void>;
  /** Back to lightweight mode; detaches every view stream of the session. */
  hideInteractiveView(sessionId: string): Promise<void>;
  /** Attaches one renderer connection (browser socket) to the session's world stream. */
  attachView(sessionId: string, viewId: string): Promise<void>;
  detachView(viewId: string): void;
  /** Forwards an event of the browser renderer to the host (e.g. block clicks). */
  viewInput(viewId: string, event: string, args: unknown[]): void;
  onEvent(listener: (e: RuntimeEvent) => void): () => void;
  stats(): RuntimeStats;
  shutdown(): Promise<void>;
}
