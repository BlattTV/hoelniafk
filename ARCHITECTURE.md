# Hoelni Client Suite – Architecture (as implemented)

## 1. Process model

```
Windows user session (VM)
│
├── Hoelni Client Suite.exe  (desktop/, Electron)     own window + tray; starts/stops the backend
│
├── supervisor  (dist/supervisor.js)
│     restarts the suite after a crash (backoff 1 s … 60 s); graceful stop via IPC / signals
│
├── suite main process  (dist/index.js)                         127.0.0.1:7420 only
│     ├── Web UI + REST API + SSE (Fastify)      per-launch API token, Host/Origin checks, CSP
│     ├── SQLite (node:sqlite built in, WAL)           identities, assignments, desired state, logs …
      ├── Credential vault (AES-256-GCM file)    master key via DPAPI / Credential Manager / passphrase
      ├── Services: identities · mail · discord · network · minecraft auth · rewards · linking
│     ├── SessionManager + desired-state reconciler
│     ├── MetricsCollector · structured logger · audit log · automation timers
│     ├── GameClientRuntime  (launcher, game processes, window control)
│     └── MineflayerRuntime  ── fork() + IPC (advanced serialization) ──┐
│                                                                        │
│           runtime host process 1 … n  (dist/runtime/host/main.js)  ◀──┘
│             RuntimeHostCore: up to `runtime.sessionsPerHost` mineflayer bots,
│             heartbeats (RSS, CPU, event-loop lag, threads), per-session StateCache
│             + TakeoverServer (127.0.0.1, only while "Open game" is active)
│                │
│                └── TCP per session through its NetworkProfile
│                      (bind IP / SOCKS5 / HTTP CONNECT) → Minecraft server(s)
│
└── Minecraft (javaw.exe, official client, vanilla or Fabric) – one per opened game,
      a normal desktop window (Alt-Tab, taskbar), joins the session's TakeoverServer
```

* **Fault isolation:** a crashing bot kills only its host process. The runtime reports
  `ended(reason=runtimeCrash)` for every session on it, the reconciler restarts them on a
  fresh host. Missing heartbeats (default 30 s) → the host is killed and treated as crashed.
* **Tokens never leave the main process in persistent form:** a host asks the main process
  for a Java session (`auth.request`) for a *session id*; the main process resolves the
  identity from its own bookkeeping (never from the host) and answers with access token +
  chat-signing keys (in memory only). Refresh tokens stay in the vault.

## 2. Modules

| Area | Code | Notes |
|---|---|---|
| Composition root | `src/app.ts` | wires all services; every external dependency is injectable (tests/demo) |
| Config | `src/config.ts`, `config/app.example.yaml` | validated on start; secrets are never in config |
| Data | `src/core/db.ts`, `src/identity/repository.ts` | migrations v1→v2 with automatic pre-migration backup |
| Vault | `src/vault/*` | refs `vault://identity/<id>/…`, `vault://mailbox/<id>`, `vault://app/…`; ciphertext bound to its ref (AAD); rotating backups; recovery kit |
| Identity manager | `src/identity/identityService.ts`, `health.ts` | create/template/clone (without secrets), dashboard rows, health & milestone |
| Minecraft auth | `src/minecraft/authService.ts`, `tokenCache.ts` | prismarine-auth (device code, refresh) with identity-scoped vault cache, single-flight per identity |
| Sessions | `src/minecraft/sessionManager.ts` | desired state, reconciler, reconnect policy, network guard, locks, chat persistence, openGame/closeGame (takeover, handover, background) |
| Runtime | `src/runtime/*`, `src/minecraft/mineflayerBot.ts` | `MinecraftRuntime` interface, `MineflayerRuntime` (supervised hosts), `RuntimeHostCore` |
| Live takeover | `src/runtime/host/takeover.ts` | StateCache (what the server sent) + TakeoverServer (replay + live bridge for the real game) |
| Game client | `src/client/*` | launcher (Mojang/Fabric install, Java runtime, arguments), forwarder, GameClientRuntime, window control |
| Desktop program | `desktop/*` | Electron shell: window, tray, autostart, backend lifecycle, Windows installer |
| Linking / rewards | `src/minecraft/linking.ts`, `rewards.ts`, `config/rules.yaml` | purely rule-driven (no hard-coded server texts) |
| Networking | `src/network/*` | connector (bind/SOCKS5/HTTP), public-IP detection, verification, diagnosis, conflicts |
| Mail | `src/mail/*` | imapflow (password / XOAUTH2), mailparser, nodemailer SMTP, alias adapters, identity isolation |
| Discord | `src/discord/discordService.ts` | own window per identity (desktop), user-guided sign-up, marked as set up – no OAuth app |
| Microsoft | `src/identity/microsoftAccount.ts` | Minecraft device code confirmed in the identity's Microsoft window; Outlook in the same window – no app registration |
| Operations | `src/ops/bulk.ts`, `src/core/metrics.ts`, `src/core/logger.ts`, `src/core/audit.ts`, `src/supervisor.ts` | |
| UI | `public/js/*` | dependency-free ES modules, DOM built from text nodes only |
| Test servers | `src/testserver/*` | flying-squid based local servers with Hoelni-like messages |
| Benchmark | `src/bench/bench.ts` | writes `docs/PERFORMANCE.md` |

## 3. Data model

```
identities ─┬─ minecraft_identities (1:1, uuid & msa_account UNIQUE)
            ├─ discord_identities   (1:1, discord_user_id UNIQUE)
            ├─ mail_identities      (1:1, address UNIQUE) ──▶ mail_accounts (real mailbox, may be shared)
            ├─ network_profiles     (n, identity_id NOT NULL – never shared)
            ├─ server_assignments   (identity × server: enabled, desired_state, network override)
            ├─ reward_states        (aggregate) + reward_server_states (identity × server) + reward_history
            └─ session_events, chat_log (per session id "<identity>:<server>")
servers · templates · alias_providers · mail_messages (headers only) · audit_log · app_settings
```

A SessionInstance is identity × server; one Minecraft account can therefore be online on
several servers simultaneously, each session with its own (overridable) network profile.

## 4. Session lifecycle

```
            setDesired(ONLINE) / reconciler
STOPPED ─────────────────────────────────▶ STARTING ──(network guard, spec)──▶ CONNECTING ─▶ AUTHENTICATING ─▶ ONLINE
   ▲                                          │ guard=block & IP mismatch             │                               │
   │                                          ▼                                       │ ended (kick, drop, crash)     │
   │                                     RECONNECTING ◀── retry / delay ──────────────┴───────────────────────────────┘
   │  desired OFFLINE                         │                     │ block rule (ban, whitelist, duplicate login, auth)
   └──────────── STOPPING ◀───────────────────┘                     ▼
                                                                  BLOCKED  (until the user starts it again)
```

* **Reconciler:** every `sessions.reconcileIntervalMs` and after runtime events; at most
  `sessions.maxConcurrentStarts` connection attempts in parallel; connect watchdog.
* **Reconnect policy** (`rules.yaml → reconnect`): exponential backoff with jitter, rule
  actions `retry | delay | block`, failure counter resets after `stableAfterSec` online;
  runtime crashes retry with the base delay.
* **Session restore:** desired state is persisted – after a restart (or crash) the
  reconciler brings every session that SHOULD be online back.

## 5. Real game window (decision record)

Requirement: *AFK/lightweight → "Open game" → the real Minecraft client in a normal
window (Alt-Tab, normal controls, inventory, HUD) → back to AFK – ideally from the same
session.* A browser/canvas view is explicitly not acceptable (the earlier prismarine-viewer
view was removed).

**Can a running connection be handed to another process?** Not as a socket: after login the
connection is AES/CFB8-encrypted with a key only the connecting process knows, and the
protocol has no session resumption (1.20.5+ "transfer" also means a fresh login). So the
vanilla client cannot adopt the bot's socket.

**What is possible – and implemented – is what session-holding proxies (e.g. ZenithProxy)
do: the process that holds the connection stays in the middle.**

```
server ══ encrypted connection (opened by the AFK bot, via its NetworkProfile) ══ runtime host
                                                                                   │ StateCache
Minecraft (real client) ── 127.0.0.1:<takeover port> ── TakeoverServer ────────────┘
```

1. **StateCache** (always on in mode `takeover`): records what the server sent to the bot –
   configuration phase (registries, tags, feature flags), join game, respawn, chunks
   (+ later block/light/tile-entity deltas, dropped on unload), entities (spawn + state;
   positions come from the bot's live entity table), inventory, tab list, scoreboard,
   boss bars, advancements, recipes, world border, time, weather/game events, abilities,
   health/xp. Stored as the raw decoded packets (same protocol version on both sides).
2. **Open game:** the suite opens the session's TakeoverServer (loopback, one client, only
   the session's own username, offline-mode – the game receives *no* Microsoft token) and
   launches the official client with Quick Play to it. The client logs in locally, gets the
   configuration and world state replayed and a position packet at the bot's position.
3. **Live:** every server packet is forwarded to the game as it arrives; every game packet
   goes upstream through the bot's connection. The bot sends no movement/actions while the
   game is attached; teleport confirms, keep-alives and pings are answered once (by the bot);
   the game's movement is mirrored into the bot; chat/commands typed in the game are re-sent
   through the bot's own signed chat session.
4. **Back to AFK / game closed / quit to title:** the game disconnects from the
   TakeoverServer, the bot resumes (physics, anti-AFK, its own view distance) at the spot the
   player left it. No login happened at any point – the server saw one connection all along
   (verified by the tests: exactly one join in the server's join log).

**Modes** (identity setting "Game client"):

| Mode | "Open game" | "Back to AFK" | RAM while AFK | Notes |
|---|---|---|---|---|
| `takeover` (default) | game attaches to the live session | game closes, bot continues | bot only (+ state cache) | same connection throughout |
| `handover` | game starts; right before it logs in, the bot disconnects (~1 s gap), login via the local forwarder | game closes, bot logs in again | bot only | fallback, e.g. for proxy networks that reconfigure the client on server switches |
| `background` | window restored | window minimized | 1–2 GB per account (the game holds the session) | same connection; for a few accounts |

The **launcher** installs exactly like the official launcher (version manifest v2, version
JSON with rules/features, libraries and natives, asset index/objects, log4j config, Mojang
Java runtime, Fabric profile merge), SHA-1 verified, shared across sessions; each
identity×server gets its own game directory (`data/instances/…`, options.txt with
`pauseOnLostFocus:false`). Handover/background joins go through a local **forwarder** that
applies the identity's network profile and rewrites the handshake host, because the vanilla
client cannot bind an IP or use a proxy itself. Windows window control uses user32
(EnumWindows by PID, ShowWindow, SetForegroundWindow, WM_CLOSE) via a persistent PowerShell
helper; X11 uses xdotool when present.

**Limits (honest):** takeover depends on the StateCache covering everything the client needs;
it is tested against local servers on 1.20.1, 1.20.2 (configuration phase) and 1.21.1
(per-registry data, chunk batches) with a vanilla-behaving protocol client, not with the
real game binary (not downloadable in the build environment). A server that moves the
player to another backend with a *configuration* restart (Velocity on 1.20.2+) ends the
takeover with a message – press "Open game" again. The game must use the same version as
the server (default: detected via a status ping through the network profile).

## 6. Security model

* Local only (127.0.0.1), per-launch API token embedded in the served page, Host header
  (DNS rebinding) and Origin checks, strict CSP for the UI.
* The takeover endpoint listens on 127.0.0.1 only while a game is being opened/attached,
  accepts a single client with the session's own username, and never sees Microsoft
  tokens (the game runs in offline mode against it; the bot's authenticated connection is
  the only one to the server). Handover/background launches pass the Minecraft access token
  on the game's command line, exactly like the official launcher.
* Secrets only in the vault; SQLite and logs contain references. Logger + audit redact
  registered secrets and token-like patterns; audit refuses secret-looking keys and stores
  codes masked (`AB****`).
* Isolation checks on every cross-resource access (vault scope, network profile ownership,
  mailbox/alias ownership, unique Discord/Minecraft accounts).
* Mail HTML is rendered in a sandboxed iframe; remote images are blocked.

## 7. Observability

* Structured JSON logs (`data/logs/hoelni.log`, rotation) + in-memory buffer (Logs page),
  context `identityId`/`sessionId`; runtime host logs are forwarded with session context.
* Session events (state changes, kicks, starts, game takeover/attach/detach/close) and persisted chat per session.
* Metrics every 5 s (Monitoring page): RAM/CPU/event-loop lag of main + hosts, threads,
  process count, session states, network throughput.
* Audit log for security-relevant actions.

## 8. Test levels

| Label | Meaning | Where |
|---|---|---|
| MOCK | fakes for external systems (bots, mailboxes, Minecraft sign-in, IP) | `tests/*.test.ts` |
| LOCAL INTEGRATION | real protocols against local servers: mineflayer ↔ flying-squid, runtime host processes, socket binding, SOCKS5/HTTP proxies, IMAP (hoodiecrow), SMTP (smtp-server), launcher against a local Mojang/Fabric mirror, Open game / live takeover with a protocol-level game emulator started through the real launch command line (`tests/fixtures/`), browser E2E | `tests/launcher.test.ts`, `tests/integration/*`, `tests/e2e/*` |
| REAL SERVICE | real Microsoft/Google/Discord/Cloudflare endpoints, public IP services | pending – needs real accounts (see FINAL_STATUS.md) |
| REAL ACCOUNT | real Minecraft account on your server | pending – needs your account |
