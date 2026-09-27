# Setup – from a fresh Windows system to a running suite

Target: a Windows 10/11 VM (or PC) that runs the Hoelni Client Suite for your own Minecraft
server. All steps are done as the **Windows user that will run the suite** – the vault key
is protected by DPAPI for exactly this user.

## 1. Install prerequisites

1. **Node.js 20 LTS or 22 LTS (x64)** – <https://nodejs.org> → Windows Installer.
   Keep "Automatically install the necessary tools" enabled (Python + VS Build Tools are needed
   to compile `better-sqlite3` if no prebuilt binary matches).
2. **Git** – <https://git-scm.com/download/win>.
3. Open a new *PowerShell* and check:

   ```powershell
   node -v   # v20.x or v22.x
   npm -v
   git --version
   ```

## 2. Get the code and build

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
2. **Settings & Vault → OAuth clients** (see section 6).
3. **Server Profiles** – add your Minecraft server(s) (host, port, version or empty = auto).
4. **Mailboxes & Aliases** – add mailbox(es): IMAP with password/app password, or
   Microsoft/Google via OAuth2. Optional alias provider (plus addressing / Cloudflare).
5. **Network** – follow [NETWORKING.md](NETWORKING.md) to give every identity its own source IP.
6. **＋ New Identity** – run the wizard for **one** identity:
   Mail → Minecraft (Microsoft sign-in via device code) → Discord (OAuth2) → Network profile
   (+ Diagnose) → Server assignments → Verification. Continue until all six milestone items are
   green: `Minecraft ✓ Mail ✓ Discord ✓ Discord Link ✓ Exit IP ✓ Session ✓`.
7. Then scale with **Templates** and **Clone (without secrets)**; set sessions online in the
   **Account × Server** matrix.

## 6. OAuth applications (your own, one-time)

Redirect URI for all providers (also shown in *Settings & Vault*):
`http://127.0.0.1:7420/oauth/callback`

| Provider | Where | What to enter in the suite |
|---|---|---|
| Discord | <https://discord.com/developers/applications> → New Application → OAuth2 → add the redirect URI | Client ID (+ Client Secret, stored in the vault). Scope used: `identify` |
| Microsoft (Outlook/Hotmail mailboxes) | Azure Portal → App registrations → New registration → "Personal Microsoft accounts" (or as needed) → Authentication → Mobile and desktop platform with the redirect URI → API permissions: `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access` | Client ID, tenant (`consumers` for outlook.com) |
| Google (Gmail) | Google Cloud Console → APIs & Services → OAuth consent screen + Credentials → OAuth client ID type "Desktop app" → scope `https://mail.google.com/` | Client ID (+ secret for desktop clients) |

Minecraft login needs **no** app registration: the suite uses the Microsoft device-code flow of
prismarine-auth; the wizard shows the code to enter at microsoft.com/link.

## 7. Operating

* **Account × Server** matrix: click a cell to toggle *should be online / offline*; the
  reconciler keeps the state (reconnect with backoff; bans/whitelist/duplicate logins block).
* **Open game** on an online session opens the interactive view of that session;
  **Hide game** returns to lightweight AFK mode – the session is not reconnected.
* **Monitoring**, **Logs**, **Audit Log** for operations; logs are also in `data\logs\`.
* Backups: `data\backups\` (daily SQLite), `data\vault.json.bak.*` (rotating vault copies).

## 8. Updating

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
| `npm ci` fails at `better-sqlite3` | install Node LTS with "necessary tools", or `npm install --global windows-build-tools` (older Node) |
| Session BLOCKED | see the reason in the session row / Session log; fix it (whitelist, ban, duplicate login) and press Start |
| Session RECONNECTING with "Network guard" | exit IP mismatch – run *Network → Diagnose* |
| Microsoft sign-in keeps asking | complete the device code within 15 minutes; check *Minecraft auth* in the identity |
| Game view blank | browser needs WebGL; try Chrome/Edge; check the session is ONLINE |
