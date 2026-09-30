# Hoelni update server

Runs in your own LXC (Debian/Ubuntu). It watches the repository branch, builds every new commit,
signs the release (Ed25519) and serves it to your suites. The suites check for updates, verify the
signature with the key you confirmed once, install on a restart and roll back automatically if the
new version does not start.

```
GitHub branch ──(poll every 15 min)──▶ update server (LXC)            suite (Windows)
                                        git fetch → npm ci → build     Settings → Updates
                                        → backend bundle (zip)         check → signature ✓ (pinned key)
                                        → signed manifest               download → SHA-256 ✓ → staging
                                        http://<lxc>:8787  ◀────────── install → restart (exit 75)
                                                                        supervisor swaps files → start
                                                                        crash within 2 min → rollback
```

## Install (one command, as root in the container)

```bash
curl -fsSL https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/update-server/install.sh | bash
```

Private repository – give it a GitHub token with read access (fine-grained: *Contents: read*):

```bash
curl -fsSL -H "Authorization: token ghp_XXXX" https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/update-server/install.sh | GIT_TOKEN=ghp_XXXX bash
```

The script installs git, build tools and Node.js 22, creates the service user `hoelni-updates`,
generates the signing key (`/etc/hoelni-updates/signing.key`, never leaves the container) and an
admin token, builds the current version and starts the systemd service. At the end it prints:

```
Update URL:      http://192.168.1.50:8787
Key fingerprint: 0771:4160:f88e:5eee:5a49:e91d:154e:b25e
Admin token:     …   (shown once)
```

Options as environment variables before `bash`: `BRANCH=main`, `PORT=8787`, `AUTO_BUILD_MINUTES=15`
(0 = manual only), `CHANNEL=stable`, `RUN_TESTS=1` (unit tests before publishing), `NO_BUILD=1`.
Running the command again upgrades the update server itself; config, key and releases stay.

Proxmox: an unprivileged Debian 12 container with 1–2 vCPU, 2 GB RAM and 12 GB disk is enough (installers included)
(`npm ci` of the suite needs ~600 MB, releases are ~2–5 MB each, the newest 20 are kept).

## Connect the suite

Suite → **Settings & Vault → Updates** → URL `http://<container-ip>:8787` → **Connect** → compare the
fingerprint with the one printed above → *trust*. From then on the suite checks every 6 hours
(optional: install automatically while no game window is open), shows "⬆ Update available" in the
sidebar, and **Install update** does the rest. **Roll back last update** restores the previous version.

## Commands (in the container)

```bash
hoelni-updates build                 # build the branch now (skips nothing)
hoelni-updates build --if-changed    # only if there is a new commit
hoelni-updates list                  # releases, channels
hoelni-updates promote stable 12     # point "stable" to build 12 (suites only ever move forward –
                                     # to undo an update on a PC use its "Roll back last update")
hoelni-updates build-installers      # rebuild the Windows installers (suite + agent) now
hoelni-updates attach-installer 12 "Hoelni Client Suite Setup 0.2.0.exe" 0.2.0
hoelni-updates info                  # URL, fingerprint, repo, state
hoelni-updates rotate-token          # new admin token (then: systemctl restart hoelni-updates)
journalctl -u hoelni-updates -f      # logs
```

Status page: `http://<container-ip>:8787/`.

HTTP API (admin endpoints need `Authorization: Bearer <admin token>`):

| Method | Path | |
|---|---|---|
| GET | `/api/channels/<channel>/latest` | signed manifest (public) |
| GET | `/api/public-key` | Ed25519 key + fingerprint (public) |
| GET | `/files/<build>/<file>` | bundle / installer (public) |
| POST | `/api/build` `{ "ifChanged": true, "wait": true }` | build now (admin) |
| POST | `/api/channels/<channel>` `{ "build": 12 }` | promote / roll back (admin) |
| PUT | `/api/releases/<build>/installer?name=<file.exe>&desktopVersion=<v>` | upload the Windows installer (admin, raw body) |

## What an update contains

The backend bundle holds `dist/`, `public/`, `package.json`, `package-lock.json`, `config/rules.yaml`,
`config/app.example.yaml`, `desktop/main.cjs` and `build-info.json` – no `node_modules` (those are
Windows-specific on the suite side). If `package-lock.json` changed, the supervisor runs
`npm ci --omit=dev` in the staging folder before swapping (the desktop installer bundles npm for this).
A locally edited `config/rules.yaml` is kept; the shipped one is written next to it as
`rules.yaml.new`. `config/app.yaml`, `data/` (database, vault, logs) are never touched.

The window programs (`desktop/main.cjs`, `agent-app/*`) are part of every bundle: the installed
programs start them through a small starter (`desktop/loader.cjs`, `agent-app/loader.cjs`), so the
window, tray and game-window handling update like everything else.

## Windows installers

After a release the update server also builds the Windows installers of the suite and the agent
(`scripts/build-installers.mjs`: electron-builder/NSIS on Linux – no Wine, no Windows; Node for
Windows from nodejs.org, SHA-256 checked). They are rebuilt only when their inputs change
(Electron version, starters, icons, build script) and are offered at `GET /api/downloads` and
`GET /downloads/<file>` – through the backend at the public page `https://<backend>/download`.
A failed installer build never blocks the release. First build: ~5 minutes, ~1.5 GB of tools/caches
in the data directory.

## Security

* Releases are signed with Ed25519 in the container; the suite pins the public key after you compared
  the fingerprint and rejects anything else (wrong server, manipulated files, downgrade to another
  product). Bundle SHA-256 and size come from the signed manifest.
* Plain HTTP in the LAN is fine for integrity (signature); put a reverse proxy with TLS in front if the
  server is reachable from outside.
* The GitHub token (if any) is stored in `/etc/hoelni-updates/config.json` (mode 600, service user)
  and only passed to git through an in-memory credential helper.
