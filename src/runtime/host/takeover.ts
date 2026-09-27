/**
 * Live takeover: the real Minecraft client takes over a RUNNING lightweight
 * session – same server connection, no second login (the approach session-holding
 * proxies like ZenithProxy use).
 *
 *   server ══(encrypted, the bot's connection)══ mineflayer bot (runtime host)
 *                                                    │  StateCache records the state
 *                                                    │  the server sent (registries,
 *                                                    │  join game, chunks, entities,
 *                                                    │  inventory, tab list, …)
 *   Minecraft client ──TCP 127.0.0.1:<port>──▶ TakeoverServer
 *       1. login + configuration: replay of the cached state → client is in the world
 *       2. live: server→client packets are forwarded as they arrive,
 *                client→server packets go upstream through the bot's connection
 *       3. client leaves (game closed / "Back to AFK"): the bot simply continues
 *
 * While the client is attached the bot sends no movement/actions of its own; the
 * client's movement is mirrored into the bot so it continues from the same spot.
 * Chat typed in the game is re-sent through the bot (its signed chat session).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

type Raw = Buffer;

/** Packets that describe the player's own session – the last one of each wins. */
const SINGLETONS = new Set([
  'difficulty', 'abilities', 'held_item_slot', 'update_time', 'spawn_position', 'experience', 'update_health',
  'update_view_position', 'update_view_distance', 'simulation_distance', 'initialize_world_border', 'world_border_center',
  'world_border_lerp_size', 'world_border_size', 'world_border_warning_delay', 'world_border_warning_reach', 'playerlist_header',
  'server_data', 'declare_commands', 'declare_recipes', 'tags', 'set_ticking_state', 'step_tick', 'feature_flags',
  'set_title_text', 'set_title_subtitle', 'set_title_time', 'camera', 'custom_payload',
]);

/** Packets kept as an ordered log (capped). */
const LOGS: Record<string, number> = {
  player_info: 4000, player_remove: 4000, advancements: 300, unlock_recipes: 200, scoreboard_objective: 500,
  scoreboard_score: 4000, reset_score: 4000, scoreboard_display_objective: 50, teams: 2000, boss_bar: 200, map: 100,
  recipe_book_add: 200, recipe_book_remove: 200, recipe_book_settings: 10, set_player_inventory: 200,
};

/** Chunk-local deltas applied after the chunk packet. */
const CHUNK_DELTAS = new Set(['block_change', 'multi_block_change', 'tile_entity_data', 'update_light', 'block_action']);

const SPAWNS = new Set(['spawn_entity', 'spawn_entity_living', 'named_entity_spawn', 'spawn_entity_experience_orb', 'spawn_entity_painting', 'spawn_entity_weather']);
/** Per-entity state packets: [name, keep last N]. */
const ENTITY_STATE: Record<string, number> = {
  entity_metadata: 40, entity_equipment: 12, entity_effect: 30, remove_entity_effect: 30, entity_update_attributes: 1,
  set_passengers: 1, attach_entity: 1, entity_head_rotation: 1,
};

/** Never replayed / forwarded to the local client (handled by the bot or the local server). */
const SERVER_DROP = new Set(['keep_alive', 'ping', 'bundle_delimiter', 'select_known_packs', 'finish_configuration', 'cookie_request', 'store_cookie', 'transfer', 'start_configuration']);

/** Client packets that must not go upstream (the bot already sends its own). */
const CLIENT_DROP = new Set(['keep_alive', 'teleport_confirm', 'pong', 'chunk_batch_received', 'message_acknowledgement', 'chat_session_update', 'configuration_acknowledged', 'player_loaded', 'cookie_response', 'login_acknowledged']);

/** Bot packets suppressed while a client is attached (the client plays). */
const BOT_SUPPRESS = new Set(['position', 'position_look', 'look', 'flying', 'tick_end', 'arm_animation', 'entity_action', 'held_item_slot', 'block_dig', 'use_item', 'block_place', 'player_input', 'steer_vehicle', 'vehicle_move', 'abilities', 'use_entity', 'window_click', 'close_window', 'set_creative_slot']);

interface ChunkEntry {
  chunk: Raw;
  deltas: Raw[];
}
interface EntityEntry {
  spawn: Raw[];
  state: Map<string, Raw[]>;
}

const chunkKey = (x: number, z: number) => `${x},${z}`;

export class StateCache {
  config: Raw[] = [];
  login: any = null;
  respawn: Raw | null = null;
  lastPosition: any = null;
  selfId: number | null = null;
  readonly singletons = new Map<string, Raw>();
  readonly gameEvents = new Map<number, Raw>();
  readonly logs = new Map<string, Raw[]>();
  readonly chunks = new Map<string, ChunkEntry>();
  readonly entities = new Map<number, EntityEntry>();
  inventory: Raw | null = null;
  inventorySlots: Raw[] = [];
  private inConfig = false;

  /** Records one server→client packet (parsed data + raw bytes). */
  record(state: string, name: string, data: any, raw: Raw): void {
    if (state === 'configuration') {
      if (!this.inConfig) {
        // (re)configuration started: everything known so far belongs to the old world
        this.inConfig = true;
        this.config = [];
        this.resetWorld(true);
      }
      if (!SERVER_DROP.has(name) && !/resource_pack/.test(name)) this.config.push(raw);
      return;
    }
    if (state !== 'play') return;
    this.inConfig = false;
    switch (name) {
      case 'login':
        this.login = data;
        this.selfId = data.entityId;
        this.resetWorld(false);
        return;
      case 'respawn':
        this.respawn = raw;
        this.chunks.clear();
        this.entities.clear();
        return;
      case 'position':
        this.lastPosition = data;
        return;
      case 'game_state_change':
        this.gameEvents.set(Number(data.reason), raw);
        return;
      case 'map_chunk':
        this.chunks.set(chunkKey(data.x, data.z), { chunk: raw, deltas: [] });
        return;
      case 'unload_chunk':
        this.chunks.delete(chunkKey(data.chunkX, data.chunkZ));
        return;
      case 'window_items':
        if (Number(data.windowId) === 0) {
          this.inventory = raw;
          this.inventorySlots = [];
        }
        return;
      case 'set_slot':
        if (Number(data.windowId) === 0 || Number(data.windowId) === -2) push(this.inventorySlots, raw, 400);
        return;
      case 'entity_destroy':
        for (const id of data.entityIds ?? []) this.entities.delete(id);
        return;
    }
    if (CHUNK_DELTAS.has(name)) {
      const k = deltaChunk(name, data);
      const e = k && this.chunks.get(k);
      if (e) push(e.deltas, raw, 4000);
      return;
    }
    if (SPAWNS.has(name)) {
      this.entities.set(data.entityId, { spawn: [raw], state: new Map() });
      return;
    }
    if (name in ENTITY_STATE) {
      const id = data.entityId ?? data.vehicleId ?? data.entityID;
      let e = this.entities.get(id);
      if (!e && id === this.selfId) {
        e = { spawn: [], state: new Map() };
        this.entities.set(id, e);
      }
      if (!e) return;
      const list = e.state.get(name) ?? [];
      push(list, raw, ENTITY_STATE[name]);
      e.state.set(name, list);
      return;
    }
    if (name in LOGS) {
      const list = this.logs.get(name) ?? [];
      push(list, raw, LOGS[name]);
      this.logs.set(name, list);
      return;
    }
    if (SINGLETONS.has(name)) {
      this.singletons.set(name === 'custom_payload' ? `custom_payload:${data.channel}` : name, raw);
    }
  }

  private resetWorld(all: boolean): void {
    this.respawn = null;
    this.chunks.clear();
    this.entities.clear();
    this.gameEvents.clear();
    this.inventory = null;
    this.inventorySlots = [];
    if (all) {
      this.login = null;
      this.singletons.clear();
      this.logs.clear();
    }
  }

  stats() {
    let bytes = this.config.reduce((a, b) => a + b.length, 0);
    for (const c of this.chunks.values()) bytes += c.chunk.length + c.deltas.reduce((a, b) => a + b.length, 0);
    for (const e of this.entities.values()) for (const l of [e.spawn, ...e.state.values()]) bytes += l.reduce((a, b) => a + b.length, 0);
    for (const l of this.logs.values()) bytes += l.reduce((a, b) => a + b.length, 0);
    return { chunks: this.chunks.size, entities: this.entities.size, bytes };
  }
}

function push<T>(list: T[], v: T, cap: number): void {
  list.push(v);
  if (list.length > cap) list.splice(0, list.length - cap);
}

function deltaChunk(name: string, d: any): string | null {
  switch (name) {
    case 'block_change':
    case 'tile_entity_data':
    case 'block_action':
      return d.location ? chunkKey(d.location.x >> 4, d.location.z >> 4) : null;
    case 'multi_block_change':
      if (d.chunkCoordinates) return chunkKey(d.chunkCoordinates.x, d.chunkCoordinates.z);
      return d.chunkX !== undefined ? chunkKey(d.chunkX, d.chunkZ) : null;
    case 'update_light':
      return chunkKey(d.chunkX, d.chunkZ);
  }
  return null;
}

// ---------------------------------------------------------------------------------- server

export interface TakeoverEvents {
  onAttached(username: string): void;
  onDetached(reason: string): void;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

/**
 * Local endpoint the real client connects to. One client at a time; only the
 * session's own username is accepted; loopback only.
 */
export class TakeoverServer {
  private server: any = null;
  private client: any = null;
  private attached = false;
  private readonly offs: Array<() => void> = [];
  private origWrite: ((name: string, params: any) => void) | null = null;
  port = 0;

  constructor(
    private readonly bot: any,
    private readonly cache: StateCache,
    private readonly events: TakeoverEvents,
  ) {}

  get isAttached(): boolean {
    return this.attached;
  }

  async open(): Promise<number> {
    if (this.server) return this.port;
    const mc = require('minecraft-protocol');
    const server = mc.createServer({
      host: '127.0.0.1',
      port: 0,
      'online-mode': false,
      version: this.bot.version,
      maxPlayers: 1,
      motd: 'Hoelni live session',
      keepAlive: true,
      hideErrors: true,
      enforceSecureProfile: false,
      // The game becomes the session's player: same UUID as on the real server.
      beforeLogin: (client: any) => {
        const id = this.bot.player?.uuid ?? this.bot._client?.uuid;
        if (id) client.uuid = String(id).replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/, '$1-$2-$3-$4-$5');
      },
      errorHandler: (client: any, err: Error) => {
        this.events.log('warn', `Game connection error: ${err.message}`);
        client.end('Connection error');
      },
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    this.port = server.socketServer.address().port;
    server.on('login', (client: any) => this.onLogin(client));
    return this.port;
  }

  private onLogin(client: any): void {
    const expected = String(this.bot.username ?? '').toLowerCase();
    if (this.client || String(client.username).toLowerCase() !== expected) {
      client.end(this.client ? 'The game is already connected to this session' : `This session belongs to ${this.bot.username}`);
      return;
    }
    if (this.bot._client?.state !== 'play' || !this.cache.login) {
      client.end('The session is not in the world yet – try again in a moment');
      return;
    }
    this.client = client;
    if (client.supportFeature?.('hasConfigurationState')) {
      // Replace the library's default configuration (its own registries) by the server's real one.
      client.removeAllListeners('login_acknowledged');
      client.once('login_acknowledged', () => {
        client.state = 'configuration';
        for (const raw of this.cache.config) client.writeRaw(raw);
        client.once('finish_configuration', () => {
          client.state = 'play';
          this.attach(client);
        });
        client.write('finish_configuration', {});
      });
    } else {
      this.attach(client);
    }
    client.on('end', (reason: string) => this.detach(`Game left the session${reason ? ` (${reason})` : ''}`));
  }

  private attach(client: any): void {
    try {
      this.replay(client);
    } catch (e) {
      this.events.log('error', `Replay failed: ${(e as Error).message}`);
      client.end('Could not transfer the session state');
      return;
    }
    this.attached = true;
    const bot = this.bot;
    const up = bot._client;
    bot.physicsEnabled = false;
    bot.clearControlStates?.();

    // Suppress the bot's own movement/actions while the player controls the account.
    this.origWrite = up.write.bind(up);
    up.write = (name: string, params: any) => {
      if (this.attached && BOT_SUPPRESS.has(name)) return;
      this.origWrite!(name, params);
    };

    // live: server → client
    const onPacket = (data: any, meta: any, raw: Buffer) => {
      if (!this.attached) return;
      if (meta.state !== 'play') return;
      if (meta.name === 'start_configuration') {
        client.end('The server moved you to another server – press "Open game" again');
        return;
      }
      if (SERVER_DROP.has(meta.name)) return;
      client.writeRaw(raw);
    };
    up.on('packet', onPacket);
    this.offs.push(() => up.removeListener('packet', onPacket));
    const onEnd = (reason: string) => {
      if (this.attached) client.end(`Disconnected from the server: ${reason}`);
    };
    bot.once('end', onEnd);
    this.offs.push(() => bot.removeListener('end', onEnd));

    // live: client → server
    const conv = require('mineflayer/lib/conversions');
    client.on('packet', (data: any, meta: any, raw: Buffer) => {
      if (!this.attached || meta.state !== 'play') return;
      const name = meta.name as string;
      if (CLIENT_DROP.has(name)) return;
      if (name === 'custom_payload' && /brand/i.test(String(data.channel))) return;
      if (name === 'chat_message' || name === 'chat') {
        if (data.message) bot.chat(String(data.message));
        return;
      }
      if (name === 'chat_command' || name === 'chat_command_signed') {
        bot.chat(`/${data.command}`);
        return;
      }
      if (name === 'position' || name === 'position_look' || name === 'look' || name === 'flying') {
        const e = bot.entity;
        if (e && data.x !== undefined) e.position.set(data.x, data.y, data.z);
        if (e && data.yaw !== undefined) {
          e.yaw = conv.fromNotchianYaw(data.yaw);
          e.pitch = conv.fromNotchianPitch(data.pitch);
        }
        if (e) e.onGround = data.onGround ?? data.flags?.onGround ?? e.onGround;
      } else if (name === 'held_item_slot' && typeof data.slotId === 'number') {
        bot.quickBarSlot = data.slotId;
      }
      up.writeRaw(raw);
    });
    this.events.onAttached(client.username);
    this.events.log('info', `Game attached to the live session (${this.cache.stats().chunks} chunks, ${this.cache.stats().entities} entities replayed)`);
  }

  /** Sends the cached state so the client enters the world exactly where the bot is. */
  private replay(client: any): void {
    const c = this.cache;
    const w = (raw: Raw | null | undefined) => raw && client.writeRaw(raw);
    const login = { ...c.login };
    if ('enforcesSecureChat' in login) login.enforcesSecureChat = false;
    client.write('login', login);
    w(c.respawn);
    for (const k of ['difficulty', 'abilities', 'feature_flags', 'tags', 'declare_commands', 'declare_recipes', 'server_data', 'set_ticking_state', 'step_tick']) w(c.singletons.get(k));
    for (const [k, raw] of c.singletons) if (k.startsWith('custom_payload:')) w(raw);
    for (const k of ['unlock_recipes', 'recipe_book_settings', 'recipe_book_add', 'player_info', 'player_remove']) for (const raw of c.logs.get(k) ?? []) w(raw);
    for (const k of ['spawn_position', 'update_view_distance', 'simulation_distance', 'update_view_position', 'initialize_world_border', 'world_border_center', 'world_border_size', 'world_border_lerp_size', 'world_border_warning_delay', 'world_border_warning_reach', 'update_time']) w(c.singletons.get(k));
    for (const raw of c.gameEvents.values()) w(raw);
    const batches = hasPacket(client, 'chunk_batch_start');
    if (batches) client.write('chunk_batch_start', {});
    for (const e of c.chunks.values()) {
      w(e.chunk);
      for (const d of e.deltas) w(d);
    }
    if (batches) client.write('chunk_batch_finished', { batchSize: c.chunks.size });
    for (const [id, e] of c.entities) {
      for (const raw of e.spawn) w(raw);
      for (const list of e.state.values()) for (const raw of list) w(raw);
      if (id !== c.selfId && e.spawn.length) this.syncEntity(client, id);
    }
    w(c.inventory);
    for (const raw of c.inventorySlots) w(raw);
    for (const k of ['held_item_slot', 'experience', 'update_health', 'playerlist_header']) w(c.singletons.get(k));
    for (const k of ['scoreboard_objective', 'scoreboard_display_objective', 'teams', 'scoreboard_score', 'reset_score', 'boss_bar', 'advancements', 'map', 'set_player_inventory']) for (const raw of c.logs.get(k) ?? []) w(raw);
    this.sendPosition(client);
  }

  private syncEntity(client: any, id: number): void {
    const ent = this.bot.entities?.[id];
    if (!ent?.position) return;
    const conv = require('mineflayer/lib/conversions');
    const yaw = conv.toNotchianYaw(ent.yaw ?? 0);
    const pitch = conv.toNotchianPitch(ent.pitch ?? 0);
    const p = ent.position;
    try {
      if (hasPacket(client, 'sync_entity_position')) {
        client.write('sync_entity_position', { entityId: id, x: p.x, y: p.y, z: p.z, dx: 0, dy: 0, dz: 0, yaw, pitch, onGround: !!ent.onGround });
      } else {
        client.write('entity_teleport', { entityId: id, x: p.x, y: p.y, z: p.z, yaw: toByteAngle(yaw), pitch: toByteAngle(pitch), onGround: !!ent.onGround });
      }
    } catch {
      /* unsupported layout – the spawn position is used */
    }
  }

  private sendPosition(client: any): void {
    const t = this.cache.lastPosition;
    const e = this.bot.entity;
    if (!t || !e?.position) return;
    const conv = require('mineflayer/lib/conversions');
    const pkt: any = { ...t, x: e.position.x, y: e.position.y, z: e.position.z, yaw: conv.toNotchianYaw(e.yaw), pitch: conv.toNotchianPitch(e.pitch), teleportId: 0x7fff0000 + Math.floor(Math.random() * 0xffff) };
    if (typeof t.flags === 'object' && t.flags) pkt.flags = Object.fromEntries(Object.keys(t.flags).map((k) => [k, false]));
    else pkt.flags = 0;
    if ('dx' in t) Object.assign(pkt, { dx: 0, dy: 0, dz: 0 });
    if ('dismountVehicle' in t) pkt.dismountVehicle = false;
    client.write('position', pkt);
  }

  private detach(reason: string): void {
    const was = this.attached;
    this.attached = false;
    this.client = null;
    for (const off of this.offs.splice(0)) off();
    if (this.origWrite) {
      this.bot._client.write = this.origWrite;
      this.origWrite = null;
    }
    if (was) {
      try {
        if (this.bot.currentWindow) this.bot.closeWindow(this.bot.currentWindow);
      } catch {
        /* ignore */
      }
      this.events.onDetached(reason);
    }
  }

  /** Disconnects the game (the session stays online in the bot). */
  async close(reason = 'Back to AFK'): Promise<void> {
    const c = this.client;
    if (c) c.end(reason);
    this.detach(reason);
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve())).catch(() => undefined);
  }
}

function hasPacket(client: any, name: string): boolean {
  try {
    const md = require('minecraft-data')(client.version);
    return !!md.protocol.play.toClient.types[`packet_${name}`];
  } catch {
    return false;
  }
}

function toByteAngle(deg: number): number {
  const b = Math.round((deg / 360) * 256) & 0xff;
  return b > 127 ? b - 256 : b;
}
