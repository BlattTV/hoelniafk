# Final status

Branch `claude/practical-hopper-o4bpyw`. Test labels: **MOCK** (fakes), **LOCAL INTEGRATION**
(real protocols against local servers/processes), **REAL SERVICE** (real Microsoft / Google /
Discord / Cloudflare / public IP endpoints), **REAL ACCOUNT** (real Minecraft account on your server).

## IMPLEMENTED

**Identity suite**
- IdentityProfile with Minecraft, Mail, Discord, NetworkProfile, Rewards and per-server SessionInstances; SQLite (WAL) with migrations (v1→v2, automatic backup before migrating).
- Dashboard (search, filters, sorting, per-server session dots, context menu, bulk actions), identity detail with all sections, 6-step setup wizard with READY checklist, health checks with clickable components, first-milestone view.
- Templates, identity clone without secrets, save identity as template.
- Audit log (no tokens, passwords or full codes; codes masked).

**Minecraft runtime**
- `MinecraftRuntime` abstraction; `MineflayerRuntime` with supervised runtime host processes (IPC, heartbeats, crash detection → restart, idle reaping, configurable sessions per host, pooled/identity grouping).
- Per session: `startSession`, `stopSession`, `reconnect`, `sendChat`, `getChat` (persisted), `getState`, `openGame`, `closeGame`.
- Lightweight AFK mode (physics off, anti-AFK actions).

**Real game window ("Open game") – replaces the former browser view**
- Own launcher for the **official Minecraft Java client** (vanilla or Fabric): version manifest v2, version JSON rules/features, libraries + natives, assets, log4j config, Mojang Java runtime, Fabric profile merge, SHA-1 verification, mirrors, shared installation, per-session game directory with safe `options.txt` defaults (`pauseOnLostFocus:false`, no onboarding screens).
- **Live takeover (default):** the game takes over the *running* AFK session – same server connection, no second login. The runtime host records the session state (configuration/registries, join game, chunks + deltas, entities, inventory, tab list, scoreboard, …) and replays it to the game through a loopback endpoint, then bridges all packets live; the bot pauses, mirrors the player's movement and re-sends chat through its signed chat session. Closing the game / quitting to title / "Back to AFK" hands the session back to the AFK client at the same spot. The game gets no Microsoft token in this mode.
- **Handover** mode (fallback: AFK client disconnects right before the game logs in through a local forwarder that applies the network profile and rewrites the handshake host; back to AFK = re-login) and **background** mode (the game holds the session minimized; Open game = restore window, same connection).
- Game process management: install progress, launch, join detection, chat from `logs/latest.log` into the rules (link codes, rewards), crash/exit detection, graceful close (WM_CLOSE → kill), window control (Windows user32 via a persistent PowerShell helper: find by PID, restore + focus, minimize, close; X11: xdotool).
- Version auto-detection via a status ping through the identity's network profile.

**Usability (latest round)**
- New visual design ("workbench": warm paper / charcoal themes, one accent colour, square state marks, no emoji) with light/dark switch that is remembered per PC.
- Weekly online schedules per identity × server (7×24 grid editor with presets, bulk apply; reconciler starts/stops at window borders, manual start overrides until the next change, an open game is never cut off; DB migration v3).
- Quick actions palette (Ctrl+K): pages, identities, Open game / Back to AFK / Start / Stop per session, update check, theme.
- Desktop notifications: session blocked or disconnected, link code received, update ready (toggle in Settings → This PC).
- Tray menu of the desktop program lists all sessions with Open game / Back to AFK / Start / Stop and shows online counts.
- Fix: the identity settings offered no "takeover" option for the game client mode.

**Updates (self-hosted)**
- `update-server/`: one-command installer for a Debian/Ubuntu LXC (Node 22, systemd service, service user), git polling + build per new commit, Ed25519-signed release manifests, channels/promote, installer attachment, status page, admin API with token, build lock, pruning.
- Suite updater: key pinning after fingerprint confirmation, signature + SHA-256 + size verification, staging, install via restart (exit 75) – the supervisor swaps the files while the suite is down (Windows file locks), reinstalls dependencies only if `package-lock.json` changed, keeps locally edited `rules.yaml`, rolls back automatically if the new version exits with an error within 2 minutes; manual rollback; automatic checks, optional auto-install (not while a game is open); UI card + sidebar hint.

**Desktop program**
- Electron shell (`desktop/`): own application window, tray icon (window close keeps sessions running), single instance, "Start with Windows", graceful quit via IPC, external links in the default browser, Windows installer (NSIS) bundling backend + Node runtime. Fallback start script opens an Edge app window.
- Desired-state model per identity × server (`SHOULD_BE_ONLINE/OFFLINE`), reconciler with concurrency limit and connect watchdog, rule-based reconnect policy (retry / delay / block for ban, whitelist, duplicate login, auth), exponential backoff with jitter, session restore after restart, per-session locks.
- Microsoft authentication via prismarine-auth device code with identity-scoped vault cache, single-flight token fetch, periodic token refresh; chat-signing keys passed to hosts in memory.
- Same account on several servers at once; per-session network override.

**Networking**
- Network profiles per identity (bind IP, SOCKS5 with auth, HTTP CONNECT with auth, direct), per-session override, public exit-IP detection through the profile, expected-IP verification with audit, conflict detection between identities, network guard (off / warn / block session start on mismatch), step-by-step diagnosis (bind IP present, proxy reachable, DNS, Minecraft TCP with reported local source address, public IP, isolation).

**Mail**
- IMAP (password) and OAuth2 (Microsoft, Google; XOAUTH2) mailboxes, SMTP sending, per-identity mailbox or alias on a shared mailbox, header index + bodies on demand, search/sender/subject/unread/category filters, HTML (sandboxed, remote images blocked) / text, links, attachments, manual assignment, global inbox, verification/account mail view with rule-based detection and copyable codes, alias providers (plus addressing, Cloudflare Email Routing API), single-flight sync per mailbox.

**Discord**
- OAuth2 authorization code + PKCE (scope `identify`), connect / verify (refresh) / disconnect, uniqueness per identity, user-guided "Create Discord account" (official sign-up page only), Minecraft↔Discord link workflow (UNKNOWN/WAITING/LINKED/ERROR) driven by chat rules, link codes shown in dashboard. Provisional accounts evaluated and not used (docs/DISCORD.md).

**Rewards / Stars**
- Per identity and per server: stars, eligible, received, waiting, Discord linked, last change + last message, history; aggregate per identity; manual correction; all texts in `config/rules.yaml`.

**Security / stability / operations**
- Credential vault: AES-256-GCM, master key via DPAPI (Windows default) / Windows Credential Manager / passphrase, refs only in SQLite, ciphertext bound to its ref, identity-scoped access, fsync'd writes, rotating backups with automatic fallback, passphrase-protected recovery kit + re-encryption CLI.
- Local-only API with per-launch token, Host/Origin checks, strict CSP; loopback-only takeover endpoint (one client, own username only).
- Supervisor (restart with backoff, graceful stop via IPC on Windows / signals elsewhere), graceful shutdown, uncaught-exception handling, daily SQLite online backups, structured JSON logs with rotation and redaction, in-memory log buffer, metrics collector, session event log, configuration validation, setup check page.
- UI: account × server matrix, sessions page, global chat (multi-send), monitoring (KPIs, sparklines, hosts, attention list), logs, audit, settings/vault, mailboxes/aliases, servers, templates, all mail, verification mail.
- Local flying-squid test servers (`npm run testserver`), demo with real sessions (`npm run demo`), benchmark (`npm run bench`).
- Windows helper scripts: start, autostart at logon (scheduled task), adding bind IPs.

## IMPLEMENTED – backend, agents, proxy pool

- **Backend `hoelni-backend`** (`backend/`, default address `https://afk.hoelni.de`):
  - accounts with admin/user roles and scrypt password hashes;
  - device sign-ins (manager/agent) whose tokens are stored only as SHA-256;
  - sign-in lockout;
  - per-account relay over WebSocket, with one active manager per account;
  - admin API that answers only to an admin signed in to a manager;
  - CLI (`user add/passwd/role/disable/delete/list`, `devices`, `info`);
  - LXC installer `backend/install.sh`, with TLS via Caddy/Let's Encrypt, via an existing reverse proxy, or with a self-signed certificate.
- **Manager integration:**
  - Settings → *Backend & account*: sign-in, certificate pinning with fingerprint confirmation, and a proxy for the backend connection;
  - the backend address can only be changed after an admin of the current backend confirms it;
  - *Agents* page;
  - *Accounts* page with users, devices, revoke and activity – visible only to admins;
  - identity setting *Run on: this PC / agent*.
- **Hoelni Agent** (`agent-app/`, Windows installer via electron-builder; `src/agent/`):
  - sign-in once, then it is controlled as a runtime host of the account's manager;
  - it runs only assigned sessions: start/stop, chat, and the Minecraft window (takeover on the agent PC);
  - the household can pause it; there is a tray icon and autostart;
  - the device token is protected with DPAPI (keyring or passphrase outside Windows);
  - passwords are never passed on the command line.
- **Review hardening:**
  - Agents check every manager command themselves: only public servers/proxies (DNS-resolved, no LAN/loopback/link-local/CGNAT), validated session ids, usernames and game settings (no path traversal via the version), no bind-IP profiles, nothing while paused; commands run in order.
  - The relay forwards only runtime commands manager → agent.
  - The sign-in lockout uses the proxy-added X-Forwarded-For entry (client-forged entries cannot bypass it).
  - A password change disconnects live devices; CLI revocations are enforced on the next 20 s keep-alive.
  - The manager's role is refreshed on every connection.
  - Backend/agent connection proxies live in the vault, including migration out of SQLite, and are shown only masked.
  - *Reconnect* after a takeover by another manager.
  - Proxy tests run 16 at a time and fail fast.
- **Proxy pool:**
  - import lists (socks5/http URLs, `host:port[:user:pass]`), with passwords stored only in the vault;
  - test each proxy for exit IP and latency, and flag proxies that share an exit;
  - auto-assign one proxy per identity with a distinct exit IP; the proxy becomes the identity's network profile and also applies on agents;
  - release or remove a proxy.

## TESTED

`npm test` – 24 test files / 164 tests green, `npm run test:e2e` – 11 Playwright tests green; typecheck clean, production build OK:

| Area | Level | Tests |
|---|---|---|
| Identity isolation (mail, Discord, network, Minecraft tokens, deletion, concurrency) | MOCK | `tests/isolation.test.ts` |
| Vault encryption, AAD binding, scopes, SQLite contains no secrets, backups, recovery kit | MOCK + real files | `tests/vault.test.ts` |
| Rules (mail, chat, rewards, reconnect policy), audit, logging/redaction, config validation, migrations, aliases, supervisor | MOCK / real processes | `tests/*.test.ts` |
| Identity lifecycle, Phase-F milestone, templates/clone, desired state, block rules, runtime crash, restore after restart | MOCK (inline runtime) | `tests/identity.test.ts` |
| API security (token, DNS rebinding, origin, CSP, no secrets in responses, OAuth callback) | MOCK | `tests/api.test.ts` |
| Real mineflayer sessions in runtime host processes vs. local servers: bind IP 127.0.0.2 seen by the server, link codes, rewards, multi-server, kick → reconnect, host crash recovery, ban → BLOCKED, desired offline | LOCAL INTEGRATION | `tests/integration/runtime.int.test.ts` |
| Launcher against a local mirror with format-correct Mojang/Fabric metadata: rules, natives per OS, assets, SHA-1 rejection, Fabric merge, Java runtime (executable, links), launch arguments (quick play, `--server` fallback, placeholders, classpath separator) | LOCAL INTEGRATION | `tests/launcher.test.ts` |
| Forwarder: handshake parse/rebuild (FML suffix), bind IP as source, handshake host rewrite, `beforeLogin` ordering, status pings | LOCAL INTEGRATION | `tests/launcher.test.ts` |
| **Open game** end to end: suite → launcher (installs from the mirror incl. Java) → *game process* (client emulator started with the real launch command line, speaking the real protocol like the game) → flying-squid. Live takeover: exactly one server login throughout, game in the world at the bot's position, chat + movement through the same connection, Back to AFK / quit in game → AFK continues from the new spot without rubber-banding. Handover: one extra login, bind IP + rewritten host seen by the server, Back to AFK, game closed by the user → AFK, failed launch leaves AFK untouched. Background: minimized, restore/minimize without new login, desired offline closes the game | LOCAL INTEGRATION | `tests/integration/gameclient.int.test.ts` |
| Schedules: window math (active/next change across days/weekends, description, input sanitising); reconciler: no start outside the window, start inside, stop at window end with desired state kept, manual override | MOCK | `tests/schedule.test.ts` |
| Updates: git → server build → signed release; public/admin API, path protection; suite refuses unconfirmed/foreign keys and tampered bundles; staging + apply (edited rules kept) + rollback; supervisor: exit 75 → apply → restart, crash in probation → automatic rollback | LOCAL INTEGRATION | `tests/updates.test.ts` |
| Update end to end with the real code: `hoelni-updates init` + `build` of this repository (npm ci + build, 19 s) → `serve`; an installed suite (built `dist/`, supervisor) connected via API, checked, installed → restarted as build #1 in ~1 s | LOCAL INTEGRATION (manual run) | documented here |
| Live takeover across protocol generations: 1.20.1, 1.20.2 (configuration phase), 1.21.1 (per-registry data, known packs, chunk batches) | LOCAL INTEGRATION | `tests/integration/takeover-versions.int.test.ts` |
| Source-IP binding, SOCKS5 (RFC 1929 auth) and HTTP CONNECT proxies, exit-IP detection & mismatch, network guard, diagnosis | LOCAL INTEGRATION (Linux) | `tests/integration/network.int.test.ts` |
| IMAP (imapflow ↔ local IMAP server) incl. XOAUTH2, SMTP (PLAIN, XOAUTH2), OAuth2 code exchange with PKCE verification + refresh, Discord API over HTTP | LOCAL INTEGRATION | `tests/integration/mail.int.test.ts` |
| UI: all pages without console errors, dashboard filter/context menu, matrix toggle → ONLINE, **Open game → 🎮 game (live) → Back to AFK**, global chat command | LOCAL INTEGRATION (Playwright) | `tests/e2e/ui.spec.ts` (`npm run test:e2e`) |
| Backend ↔ manager ↔ agent over the real relay:
  - default address; an address change only with admin credentials;
  - a real mineflayer session placed on the agent reaches ONLINE;
  - chat round-trips; a pool SOCKS5 proxy is used from the agent (auth + exit address seen by the server);
  - pause/resume, where resume starts the session immediately despite a 30 s backoff;
  - admin API only for admin managers (not for users or agents), with no hashes in responses;
  - accounts cannot reach each other's agents;
  - revoking disconnects the agent for good | LOCAL INTEGRATION | `tests/integration/backend-relay.int.test.ts` |
| Agent guard (private/public addresses, LAN servers/proxies refused, path-traversal and bad settings refused); relay drops non-runtime frames; forged X-Forwarded-For cannot bypass the lockout; CLI password change disconnects a live agent; backend proxy never in SQLite or API output (incl. migration) | MOCK + LOCAL INTEGRATION | `tests/agent-guard.test.ts`, `tests/proxypool.test.ts` |
| Proxy pool:
  - parser formats;
  - import without passwords in SQLite, API or audit;
  - de-duplication;
  - tests with exit IP and latency;
  - auto-assign with distinct exit IPs;
  - credentials copied into the identity vault scope;
  - release/remove | MOCK | `tests/proxypool.test.ts` |
| UI:
  - backend sign-in as user (no *Accounts*) and as admin (*Accounts* visible);
  - rejected address change;
  - agent listed; account created;
  - *Run on* lists the agent;
  - proxy import hides passwords; assign/release | LOCAL INTEGRATION (Playwright, demo with a local backend + agent) | `tests/e2e/ui.spec.ts` |
| Agent CLI against a TLS backend with a self-signed certificate:
  - unconfirmed or wrong fingerprint refused;
  - wrong password refused;
  - sign-in, status, run, logout;
  - token in the passphrase vault vs. 0600 fallback;
  - admin check before an address change | LOCAL INTEGRATION (manual run) | documented here |
| `backend/install.sh` in a fresh `node:22-bookworm` container:
  - user/dirs, clone, `npm ci`, config, self-signed cert, service;
  - HTTPS `/health` and login against the installed service;
  - interactive admin prompt through a pty (password not echoed);
  - re-run as upgrade keeps data;
  - modes 700/600 | LOCAL INTEGRATION (Docker; apt/Caddy/systemd stubbed – Debian mirrors blocked here) | documented here |
| Performance 1–100 sessions, reconnect after connection drop | LOCAL INTEGRATION | `npm run bench` → docs/PERFORMANCE.md |
| Fresh checkout acceptance: `git clone` → `npm ci` → `npm run build` → `npm start` (supervisor) → setup check → identity + server via API → session ONLINE in a runtime host → SIGTERM: clean shutdown (no processes left) → restart: session restored automatically → SIGKILL of the main process: supervisor restarts it, session restored, the old host exits on IPC disconnect | LOCAL INTEGRATION (manual run, built `dist/`) | documented here |

## MEASURED PERFORMANCE (LOCAL INTEGRATION, 4-vCPU Xeon, Linux)

| Sessions | Host processes | RAM total | CPU (of one core) | Connect all | Reconnect all after drop |
|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 258 MB | 2 % | 1 s | – |
| 15 | 2 | 447 MB | 6 % | 1.3 s | 3.5 s |
| 50 | 5 | 976 MB | 14 % | 2.8 s | – |
| 100 | 10 | 1.71 GB | 33 % | 3.1 s | 11.6 s |

Lightweight mode saves ~⅔ of the CPU compared to physics always on; one process per session would
cost ~168 MB per session. The live-takeover state cache adds ~2 MB per session on the test worlds
(100 sessions: 1.95 GB). Each *open* game window costs what the official client costs (1–2 GB).
Details and method: docs/PERFORMANCE.md.

## REAL-SERVICE-TESTED

Nothing yet. The build environment had no access to Microsoft, Google, Discord, Mojang,
Fabric or public-IP services (egress blocked) and no credentials were provided.

**Not executed here and therefore not claimed as tested:** the real Minecraft client binary
(Mojang downloads blocked – the tests run the identical launch command line against a
protocol-level client emulator), the Windows window control (no Windows), the Electron
desktop program and its installer (Electron binaries not downloadable here; syntax-checked
only), the same applies to the **Hoelni Agent** window (its HTML/JS was exercised in Chromium with a mocked bridge; the Electron shell is syntax-checked only). First real run: `npm run demo` on Windows → *Open game* on any online session downloads
Minecraft 1.20.1 and takes over the session on the local offline test server – no account needed.

## REQUIRES USER CREDENTIALS

All integrations are implemented end-to-end; only the following values/accounts are missing:

| What | Where to enter | Needed for |
|---|---|---|
| Discord OAuth app (client ID, client secret) | Settings & Vault | connecting Discord accounts |
| Microsoft Azure app registration (client ID, tenant) | Settings & Vault | Outlook/Hotmail mailboxes via OAuth2 |
| Google OAuth client (desktop) | Settings & Vault | Gmail via OAuth2 |
| IMAP passwords / app passwords | Mailboxes & Aliases | generic IMAP mailboxes |
| Microsoft accounts owning Minecraft Java | Identity → Minecraft (device code sign-in) | online-mode servers |
| Cloudflare API token + zone (optional) | Mailboxes & Aliases → alias provider | alias creation |
| Your server address/version and the exact chat texts | Server Profiles, `config/rules.yaml` | link codes, rewards, reconnect rules |
| Internet access to Mojang/Fabric download hosts (or a mirror) | `client.mirrors` | first "Open game" |
| Windows bind IPs, OPNsense, VPN, exit VPS with public IPv4s | see NETWORKING.md | one exit IP per identity |

Pending real tests once these exist: Microsoft device-code login → join your online-mode server
(REAL ACCOUNT); **Open game with the real client: takeover on your server's version and plugins
(REAL SERVICE + REAL ACCOUNT)**; Discord OAuth connect; Outlook/Gmail OAuth IMAP; Cloudflare alias creation;
public-IP verification through the real VPN exits; the rules against your server's real messages.

## KNOWN LIMITATIONS

- A socket cannot be moved between processes (encrypted, no session resumption). The live
  takeover therefore keeps the AFK process in the middle (like session-holding proxies): the
  game plays through it. Anything the state cache does not cover would be missing until the
  server resends it (e.g. a map item's pixels sent before the takeover beyond the cache cap).
- Proxy networks that move players between backends with a *configuration* restart
  (Velocity, 1.20.2+) end the takeover (message in the game) – press Open game again or use
  mode `handover`.
- While attached, typed chat is re-sent by the AFK client (its signed chat session); the game
  itself runs in offline mode against the local endpoint, so it shows your skin only if the
  server sends it (it does on normal servers via the tab list).
- Supported Minecraft versions follow mineflayer/minecraft-protocol (up to 26.1 in the installed
  versions); takeover is tested on 1.20.1, 1.20.2 and 1.21.1.
- Chat typed in the game is read from `latest.log` in handover/background modes (no mod);
  in takeover mode chat comes directly from the session.
- Linux-only parts of the network tests use 127.0.0.x loopback aliases; on Windows the bind-IP
  path is the same code but was not executed here.
- DPAPI and Windows Credential Manager key providers are implemented but could only be
  unit-tested indirectly (no Windows in the build environment); the passphrase provider and the
  AES layer are fully tested.
- Thread counts in Monitoring are read from `/proc` (Linux); on Windows they show "–".
- Local test servers (flying-squid) approximate a Paper/Spigot server; behaviour of your real
  server (plugins, anti-cheat, rate limits) must be validated with a real account.

## NEXT OPTIONAL IMPROVEMENTS

- IMAP IDLE for instant verification mails; rules editor in the UI.
- Additional alias adapters (SimpleLogin, addy.io).
- Validate takeover with the real client on your server version; extend the state cache if a
  plugin feature (e.g. custom map art, resource-pack prompts) needs it.
- Code-signing for the installer; automatic replacement of the desktop shell itself (today: installer download link).
- `update-server/install.sh` was syntax-checked and its steps executed individually (init/build/serve as a normal user); the systemd/apt parts need a real Debian/Ubuntu container to verify.
- `backend/install.sh`: package installation (NodeSource, Caddy repository), the real systemd unit and the Let's Encrypt certificate were not executable here (no Debian mirrors / no public DNS) – verify during the first real install.
- Per-host CPU/RAM limits and automatic rebalancing of sessions across hosts.
- Windows service packaging (installer) and signed builds.
