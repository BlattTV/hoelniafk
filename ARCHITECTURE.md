# Hoelni Client Suite – Architecture (as implemented)

## 1. Process model

```
Windows user session (VM)
│
├── supervisor  (npm start → dist/supervisor.js)
│     restarts the suite after a crash (backoff 1 s … 60 s), forwards SIGINT/SIGTERM
│
└── suite main process  (dist/index.js)                         127.0.0.1:7420 only
      ├── Web UI + REST API + SSE (Fastify)      per-launch API token, Host/Origin checks, CSP
      ├── View relay (socket.io /view-io/)       token-protected interactive game view
      ├── SQLite (better-sqlite3, WAL)           identities, assignments, desired state, logs …
      ├── Credential vault (AES-256-GCM file)    master key via DPAPI / Credential Manager / passphrase
      ├── Services: identities · mail · discord · network · minecraft auth · rewards · linking
      ├── SessionManager + desired-state reconciler
      ├── MetricsCollector · structured logger · audit log · automation timers
      └── MineflayerRuntime  ── fork() + IPC (advanced serialization) ──┐
                                                                         │
            runtime host process 1 … n  (dist/runtime/host/main.js)  ◀──┘
              RuntimeHostCore: up to `runtime.sessionsPerHost` mineflayer bots,
              heartbeats (RSS, CPU, event-loop lag, threads), world stream for views
                 │
                 └── TCP per session through its NetworkProfile
                       (bind IP / SOCKS5 / HTTP CONNECT) → Minecraft server(s)
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
| Sessions | `src/minecraft/sessionManager.ts` | desired state, reconciler, reconnect policy, network guard, locks, chat persistence, views |
| Runtime | `src/runtime/*`, `src/minecraft/mineflayerBot.ts` | `MinecraftRuntime` interface, `MineflayerRuntime` (supervised hosts), `RuntimeHostCore` |
| Interactive view | `src/web/viewRelay.ts`, `public/view/*` | prismarine-viewer renderer + control overlay on the same running session |
| Linking / rewards | `src/minecraft/linking.ts`, `rewards.ts`, `config/rules.yaml` | purely rule-driven (no hard-coded server texts) |
| Networking | `src/network/*` | connector (bind/SOCKS5/HTTP), public-IP detection, verification, diagnosis, conflicts |
| Mail | `src/mail/*` | imapflow (password / XOAUTH2), mailparser, nodemailer SMTP, alias adapters, identity isolation |
| Discord | `src/discord/discordService.ts`, `src/core/oauth.ts` | OAuth2 code + PKCE, verify/refresh, user-guided sign-up |
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

## 5. Interactive game view (decision record)

Requirement: *AFK/lightweight → open game → fully controllable view → hide → lightweight,
without losing the session.*

* **Chosen (implemented, tested):** the view is attached to the **same mineflayer session**.
  The host streams world/entities/position of the running bot (prismarine-viewer
  `WorldView`) through the main process to a browser window (`/view/<token>/`, three.js
  renderer). Keyboard/mouse (pointer lock) are translated into control inputs
  (move, jump, sprint, sneak, look, attack/dig, use/place, hotbar, chat, inventory).
  Opening a view switches physics on and pauses anti-AFK; hiding detaches the stream and
  returns to lightweight mode (physics off). No reconnect happens – verified by
  `tests/integration/view.int.test.ts` (same `onlineSince`, reconnect counter unchanged)
  and the Playwright E2E test.
* **Not chosen: Fabric/vanilla client runtime.** A running protocol session cannot be
  handed over to another client process (encryption/session state live in the process),
  so a vanilla client would have to *be* the session from the start: ~1–2 GB RAM per
  account instead of ~15–30 MB, and the Mojang/Fabric download endpoints plus a desktop
  environment are required. In this build environment those endpoints are blocked, so a
  Fabric PoC could not be built or tested; it is therefore not shipped as a feature.
  The `MinecraftRuntime` interface is the extension point if a client runtime is added later.

## 6. Security model

* Local only (127.0.0.1), per-launch API token embedded in the served page, Host header
  (DNS rebinding) and Origin checks, strict CSP for the UI; the game view pages allow
  `unsafe-eval` (required by the renderer bundle) but are reachable only with an
  unguessable, revocable view token.
* Secrets only in the vault; SQLite and logs contain references. Logger + audit redact
  registered secrets and token-like patterns; audit refuses secret-looking keys and stores
  codes masked (`AB****`).
* Isolation checks on every cross-resource access (vault scope, network profile ownership,
  mailbox/alias ownership, unique Discord/Minecraft accounts, OAuth state bound to identity).
* Mail HTML is rendered in a sandboxed iframe; remote images are blocked.

## 7. Observability

* Structured JSON logs (`data/logs/hoelni.log`, rotation) + in-memory buffer (Logs page),
  context `identityId`/`sessionId`; runtime host logs are forwarded with session context.
* Session events (state changes, kicks, starts, view open/hide) and persisted chat per session.
* Metrics every 5 s (Monitoring page): RAM/CPU/event-loop lag of main + hosts, threads,
  process count, session states, network throughput.
* Audit log for security-relevant actions.

## 8. Test levels

| Label | Meaning | Where |
|---|---|---|
| MOCK | fakes for external systems (bots, mailboxes, OAuth, IP) | `tests/*.test.ts` |
| LOCAL INTEGRATION | real protocols against local servers: mineflayer ↔ flying-squid, runtime host processes, socket binding, SOCKS5/HTTP proxies, IMAP (hoodiecrow), SMTP (smtp-server), OAuth2 over HTTP with PKCE, browser E2E | `tests/integration/*`, `tests/e2e/*` |
| REAL SERVICE | real Microsoft/Google/Discord/Cloudflare endpoints, public IP services | pending – needs your OAuth apps (see FINAL_STATUS.md) |
| REAL ACCOUNT | real Minecraft account on your server | pending – needs your account |
