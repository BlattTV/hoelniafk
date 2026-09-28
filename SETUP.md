# Setup – from a fresh Windows system to a running suite

Target: a Windows 10/11 VM (or PC) that runs the Hoelni Client Suite for your own Minecraft
server. All steps are done as the **Windows user that will run the suite** – the vault key
is protected by DPAPI for exactly this user.

## 1. Install prerequisites

1. **Node.js 22 LTS (22.13 or newer) or 24 (x64)** – <https://nodejs.org> → Windows Installer.
   No compiler / Visual Studio is needed: the database uses Node's built-in SQLite.
2. **Git** – <https://git-scm.com/download/win>.
3. Open a new *PowerShell* and check:

   ```powershell
   node -v   # v20.x or v22.x
   npm -v
   git --version
   ```

## 2. Get the code and build

> **Desktop program (recommended):** after the build below, create the Windows installer once:
>
> ```powershell
> cd desktop
> npm install
> npm run dist        # → desktop\release\Hoelni Client Suite Setup <version>.exe
> ```
>
> Install it; the start menu entry **Hoelni Client Suite** opens the suite in its own window
> with a tray icon (closing the window keeps the sessions running, *Quit* in the tray stops
> them). The installer bundles the backend and the Node runtime it was built with; data lives
> in `%APPDATA%\Hoelni Client Suite\data`. Tray → *Start with Windows* replaces the scheduled task.
> Without the installer: `cd desktop && npm install && npm start` runs the desktop window
> against the repository, or `scripts\windows\start-hoelni.cmd` opens an Edge app window.


```powershell
cd C:\
git clone https://github.com/BlattTV/hoelniafk.git
cd hoelniafk
git checkout claude/practical-hopper-o4bpyw
npm ci
npm run build
npm test            # optional: unit + local integration tests (~2 min)
```

## 3. Configure (no secrets in files)

```powershell
copy config\app.example.yaml config\app.yaml
notepad config\app.yaml
```

Relevant keys (all documented in the file):

| Key | Default | Meaning |
|---|---|---|
| `port` | 7420 | UI/API port on 127.0.0.1 |
| `vault.keyProvider` | `auto` | Windows → DPAPI; alternatives `credman`, `passphrase` |
| `runtime.sessionsPerHost` | 10 | sessions per runtime host process (see docs/PERFORMANCE.md) |
| `sessions.maxConcurrentStarts` | 4 | parallel connection attempts after a restart |
| `automation.*` | | mail/network/Discord/token checks, `restoreSessions` |
| `client.javaPath` | empty | use this Java instead of Mojang's runtime (downloaded automatically) |
| `client.rootDir` / `client.instancesDir` | `data\minecraft`, `data\instances` | game installation (shared) / per-session game folders |
| `client.mirrors` | – | host → base URL, e.g. a local mirror of Mojang's download hosts |

Recognition rules (verification mails, link codes, stars, reconnect policy) live in
`config/rules.yaml`. Adapt the chat texts to the exact messages of your server; reload them in
the UI (*Settings & Vault → Reload rules*).

## 4. Start

```powershell
npm start                 # supervised; or: scripts\windows\start-hoelni.cmd
```

Open <http://127.0.0.1:7420>. On first start the vault (`data\vault.json`) and its
DPAPI-protected key (`data\vault.key.dpapi`) are created.

**Autostart at logon** (runs as your user, restarts after crashes):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1
```

## 5. First-time setup in the UI

Open **Setup Check** – it lists what is still missing. Recommended order:

1. **Settings & Vault → Export recovery kit.** Store the file offline and the passphrase separately.
   Without it, the secrets cannot be recovered on another PC / Windows user
   (`npm run vault -- recover --kit <file>`).
2. Nothing to register – see section 6.
3. **Server Profiles** – add your Minecraft server(s) (host, port, version or empty = auto).
4. **Mailboxes & Aliases** (optional) – IMAP mailboxes with password/app password for automatic code
   recognition. Optional alias provider (plus addressing / Cloudflare). Outlook needs nothing here.
5. **Network** – follow [NETWORKING.md](NETWORKING.md) to give every identity its own source IP.
6. **＋ New Identity** – run the wizard for **one** identity:
   Microsoft (Minecraft + Outlook in the identity's window) → Discord (own window) → Network profile
   (+ Diagnose) → Server assignments → Verification. Continue until all six milestone items are
   green: `Minecraft ✓ Mail ✓ Discord ✓ Discord Link ✓ Exit IP ✓ Session ✓`.
7. Then scale with **Templates** and **Clone (without secrets)**; set sessions online in the
   **Account × Server** matrix.

## 6. No developer apps needed

The suite needs no OAuth apps (no Azure app registration, no Discord or Google developer app):

* **Minecraft:** Microsoft's own Minecraft sign-in (device code). The desktop program opens the
  confirmation page with the code already filled in, in the identity's own Microsoft window.
* **Outlook:** runs in the same Microsoft window (same login). The suite stores no mail tokens.
* **Discord:** its own window per identity; the user registers / signs in there and marks it as set up.
* **Optional IMAP mailboxes** (automatic code recognition): password / app password, stored in the vault.

## 7. Operating

* **Account × Server** matrix: click a cell to toggle *should be online / offline*; the
  reconciler keeps the state (reconnect with backoff; bans/whitelist/duplicate logins block).
* **Open game** starts the **real Minecraft client** for that session as a normal window
  (Alt-Tab, taskbar, normal controls, inventory, HUD). The first time, the official client
  (the server's version, detected automatically) and Mojang's Java are downloaded into
  `data\minecraft` (~0.5–1 GB, progress is shown at the session). Default mode **takeover**:
  the game takes over the running AFK session – **same connection, no new login**; closing
  the game, quitting to the title screen or **Back to AFK** hands the session back to the
  AFK client at the same spot. Per identity (*Identity → Settings → Game client*) you can
  choose `handover` (quick re-login instead) or `background` (the game holds the session all
  the time, minimized), the Minecraft version, Vanilla/Fabric and the memory.
  Chat typed in the game is sent through the session (rules, link codes and rewards keep
  working); while the game is open, "send chat" from the suite also still works in
  takeover mode.
* **Monitoring**, **Logs**, **Audit Log** for operations; logs are also in `data\logs\`.
* Backups: `data\backups\` (daily SQLite), `data\vault.json.bak.*` (rotating vault copies).

## 8. Updating

**Recommended: own update server in a LXC** (builds every new commit, signs it, the suites install
it with one click and roll back automatically). In the container, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/update-server/install.sh | bash
```

Then in the suite: *Settings & Vault → Updates* → URL shown by the installer → *Connect* → compare
the key fingerprint → *Install update* whenever "⬆ Update available" appears. Details, private
repositories and commands: [update-server/README.md](update-server/README.md).

Manually from the repository:

```powershell
git pull
npm ci
npm run build
# restart (scheduled task: Stop-ScheduledTask / Start-ScheduledTask -TaskName HoelniClientSuite)
```

Database migrations run automatically; a copy of the old database is written to
`data\hoelni.db.pre-vN.bak` first.

## 9. Trying it without real accounts

```powershell
npm run demo        # http://127.0.0.1:7421 – 15 identities on 3 local test servers
npm run testserver -- --port 25601 --count 1   # a local offline test server for your own experiments
```

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `Vault key is invalid` | the suite runs as a different Windows user than the one that created the vault → run as that user, or `npm run vault -- recover --kit <kit>` |
| `npm ci` fails with `EPERM … rmdir` | a previous run or an editor still holds files in `node_modules` – close VS Code/Explorer windows on the folder, delete `node_modules` and run `npm ci` again |
| "no built-in SQLite (node:sqlite)" | Node.js is older than 22.13 – install the current Node.js 22 LTS or 24 |
| Session BLOCKED | see the reason in the session row / Session log; fix it (whitelist, ban, duplicate login) and press Start |
| Session RECONNECTING with "Network guard" | exit IP mismatch – run *Network → Diagnose* |
| Microsoft sign-in keeps asking | complete the device code within 15 minutes; check *Minecraft auth* in the identity |
| Open game: "Unknown Minecraft version" | set the server's version in *Server Profiles* or the identity's game client version |
| Open game: download fails | check internet access to `piston-meta.mojang.com`, `piston-data.mojang.com`, `libraries.minecraft.net`, `resources.download.minecraft.net` (Fabric: `meta.fabricmc.net`, `maven.fabricmc.net`) or configure `client.mirrors` |
| Game window does not come to the front | Windows focus rules – use Alt-Tab / the taskbar; the game keeps running either way |
| Takeover ends with "moved you to another server" | proxy networks (Velocity 1.20.2+) reconfigure the client on server switches – press Open game again or use mode `handover` |
