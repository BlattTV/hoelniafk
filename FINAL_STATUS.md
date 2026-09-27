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
- Per session: `startSession`, `stopSession`, `reconnect`, `sendChat`, `getChat` (persisted), `getState`, `openInteractiveView`, `hideInteractiveView`, plus control input and inventory.
- Interactive 3D game view of the *same* running session in a browser window (prismarine-viewer renderer, pointer-lock mouse look, WASD/jump/sprint/sneak, attack/dig, use/place, hotbar, chat, inventory, HUD). Lightweight AFK mode (physics off) while hidden; no reconnect when switching.
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
- Local-only API with per-launch token, Host/Origin checks, strict CSP; token-protected game view pages.
- Supervisor (restart with backoff, signal forwarding), graceful shutdown, uncaught-exception handling, daily SQLite online backups, structured JSON logs with rotation and redaction, in-memory log buffer, metrics collector, session event log, configuration validation, setup check page.
- UI: account × server matrix, sessions page, global chat (multi-send), monitoring (KPIs, sparklines, hosts, attention list), logs, audit, settings/vault, mailboxes/aliases, servers, templates, all mail, verification mail.
- Local flying-squid test servers (`npm run testserver`), demo with real sessions (`npm run demo`), benchmark (`npm run bench`).
- Windows helper scripts: start, autostart at logon (scheduled task), adding bind IPs.

## TESTED

`npm test` – 17 test files / 102 tests green, `npm run test:e2e` – 6 Playwright tests green; typecheck clean, production build OK:

| Area | Level | Tests |
|---|---|---|
| Identity isolation (mail, Discord, network, Minecraft tokens, deletion, concurrency) | MOCK | `tests/isolation.test.ts` |
| Vault encryption, AAD binding, scopes, SQLite contains no secrets, backups, recovery kit | MOCK + real files | `tests/vault.test.ts` |
| Rules (mail, chat, rewards, reconnect policy), audit, logging/redaction, config validation, migrations, aliases, supervisor | MOCK / real processes | `tests/*.test.ts` |
| Identity lifecycle, Phase-F milestone, templates/clone, desired state, block rules, runtime crash, restore after restart | MOCK (inline runtime) | `tests/identity.test.ts` |
| API security (token, DNS rebinding, origin, CSP, no secrets in responses, OAuth callback) | MOCK | `tests/api.test.ts` |
| Real mineflayer sessions in runtime host processes vs. local servers: bind IP 127.0.0.2 seen by the server, link codes, rewards, multi-server, kick → reconnect, host crash recovery, ban → BLOCKED, desired offline | LOCAL INTEGRATION | `tests/integration/runtime.int.test.ts` |
| Interactive view: world stream, control movement, hide → lightweight with the same connection | LOCAL INTEGRATION | `tests/integration/view.int.test.ts` |
| Source-IP binding, SOCKS5 (RFC 1929 auth) and HTTP CONNECT proxies, exit-IP detection & mismatch, network guard, diagnosis | LOCAL INTEGRATION (Linux) | `tests/integration/network.int.test.ts` |
| IMAP (imapflow ↔ local IMAP server) incl. XOAUTH2, SMTP (PLAIN, XOAUTH2), OAuth2 code exchange with PKCE verification + refresh, Discord API over HTTP | LOCAL INTEGRATION | `tests/integration/mail.int.test.ts` |
| Browser UI: all pages without console errors, dashboard filter/context menu, matrix toggle → ONLINE, game view open/hide in a popup, global chat command | LOCAL INTEGRATION (Playwright) | `tests/e2e/ui.spec.ts` (`npm run test:e2e`) |
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
cost ~168 MB per session. Details and method: docs/PERFORMANCE.md.

## REAL-SERVICE-TESTED

Nothing yet. The build environment had no access to Microsoft, Google, Discord, Mojang,
Fabric or public-IP services (egress blocked) and no credentials were provided.

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
| Windows bind IPs, OPNsense, VPN, exit VPS with public IPv4s | see NETWORKING.md | one exit IP per identity |

Pending real tests once these exist: Microsoft device-code login → join your online-mode server
(REAL ACCOUNT); Discord OAuth connect; Outlook/Gmail OAuth IMAP; Cloudflare alias creation;
public-IP verification through the real VPN exits; the rules against your server's real messages.

## KNOWN LIMITATIONS

- The interactive view is a browser renderer (prismarine-viewer) of the running protocol
  session, not the vanilla client: no vanilla GUIs (e.g. crafting screens), resource packs,
  shaders or mods; inventory is shown as a list. Rendering needs WebGL.
- A Fabric/vanilla client runtime was evaluated but not built: it cannot take over a running
  session, needs ~1–2 GB RAM per account, and Mojang/Fabric downloads were not reachable here.
- mineflayer/prismarine-viewer support is bounded by their supported Minecraft versions
  (viewer up to 1.21.4 at the time of writing).
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
- Optional Fabric client runtime behind the same `MinecraftRuntime` interface for vanilla GUIs.
- Per-host CPU/RAM limits and automatic rebalancing of sessions across hosts.
- Windows service packaging (installer) and signed builds.
