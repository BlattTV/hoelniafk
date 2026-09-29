/**
 * Minecraft runtime abstraction.
 *
 *   MinecraftRuntime
 *   └── MineflayerRuntime      lightweight protocol client (mineflayer) running in
 *                              supervised host processes – the AFK / lightweight mode.
 *
 * The real, playable game window is provided by the ClientManager (src/client),
 * which launches the official Minecraft Java client for a session.
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
  /** Lightweight mode: physics disabled (unless the AFK action needs it). */
  lightweight: boolean;
  viewDistance: 'tiny' | 'short' | 'normal' | 'far';
  /** Record the session state so the real game can take over the live connection ("Open game"). */
  takeover?: boolean;
  /** Run on this remote agent (household PC) instead of a local runtime host. */
  placement?: { agentId: number } | null;
  /** Send chat without signatures (some proxy/translation setups kick signed chat). */
  unsignedChat?: boolean;
  /** Macros of this session (macro builder), started by their triggers. */
  macros?: import('../macros/types.js').MacroProgram[];
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
  version: string | null;
}

export type RuntimeEvent =
  | { type: 'phase'; sessionId: string; phase: RuntimeSessionPhase }
  | { type: 'spawned'; sessionId: string; username: string; uuid: string | null; version: string | null }
  | { type: 'chat'; sessionId: string; text: string; ts: string }
  | { type: 'ended'; sessionId: string; reason: string; kicked: boolean; error: string | null }
  | { type: 'stats'; sessionId: string; stats: SessionStats }
  /** Diagnostic entry for the session log (server switch, held chat, library errors). */
  | { type: 'note'; sessionId: string; kind: string; detail: string }
  /** Live takeover of a lightweight session by the real game (MineflayerRuntime only). */
  | { type: 'takeover'; sessionId: string; status: TakeoverStatus; port?: number; message?: string }
  | { type: 'macro'; sessionId: string; macroId: number; status: 'started' | 'finished' | 'stopped' | 'error' | 'log'; message?: string }
  /** Real game client lifecycle (GameClientRuntime only). */
  | { type: 'game'; sessionId: string; game: GameInfo };

/** parked: the live session is reconnecting (e.g. expired session renewed) – the game stays connected. */
export type TakeoverStatus = 'ready' | 'attached' | 'detached' | 'closed' | 'error' | 'parked';

export type GameStatus = 'installing' | 'launching' | 'starting' | 'running' | 'closing' | 'closed' | 'failed';

export interface GameInfo {
  status: GameStatus;
  pid: number | null;
  /** The window is supposed to be in front (false = minimized in the background). */
  visible: boolean;
  mode: 'takeover' | 'handover' | 'background';
  version: string | null;
  progress: { stage: string; done: number; total: number } | null;
  message: string | null;
  startedAt: string | null;
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
  /** Opens the local endpoint through which the real game takes over the live session; returns its port. */
  openTakeover(sessionId: string): Promise<number>;
  /** Disconnects the game from the session (the session itself stays online). */
  closeTakeover(sessionId: string, reason?: string): Promise<void>;
  /** The session runs on a remote agent (household PC). */
  isRemoteSession?(sessionId: string): boolean;
  /** Command for the agent that runs a session (game window on that PC). */
  sendToSessionHost?(sessionId: string, m: import('./protocol.js').MainToHost): boolean;
  /** Macro commands for the host (local or agent) that runs the session. */
  macroCommand?(m: Extract<import('./protocol.js').MainToHost, { cmd: 'macros.set' | 'macro.run' | 'macro.stop' }>): boolean;
  onEvent(listener: (e: RuntimeEvent) => void): () => void;
  stats(): RuntimeStats;
  shutdown(): Promise<void>;
}
