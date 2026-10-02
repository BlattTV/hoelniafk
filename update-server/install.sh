#!/usr/bin/env bash
# Hoelni Client Suite – update server installer for a Debian/Ubuntu LXC (Proxmox etc.).
#
# One command (as root in the container):
#   curl -fsSL https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/update-server/install.sh | bash
# Private repository: pass a GitHub token (read access to the repo):
#   curl -fsSL -H "Authorization: token <TOKEN>" https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/update-server/install.sh | GIT_TOKEN=<TOKEN> bash
#
# Options (environment variables):
#   BRANCH=<branch>        branch to build releases from   (default: claude/practical-hopper-o4bpyw)
#   REPO=<git url>         repository                       (default: https://github.com/BlattTV/hoelniafk.git)
#   PORT=8787              HTTP port
#   HOST=0.0.0.0           listen address (127.0.0.1 when only the local hoelni-backend passes updates on)
#   CHANNEL=stable         channel new builds are published to
#   AUTO_BUILD_MINUTES=15  poll the branch and build new commits (0 = only manual builds)
#   RUN_TESTS=0            1 = run the unit tests before publishing
#   NO_BUILD=1             skip the first build at the end
#
# Running the script again upgrades the update server and keeps config, key and releases.
set -euo pipefail

REPO="${REPO:-https://github.com/BlattTV/hoelniafk.git}"
BRANCH="${BRANCH:-claude/practical-hopper-o4bpyw}"
PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
CHANNEL="${CHANNEL:-stable}"
AUTO_BUILD_MINUTES="${AUTO_BUILD_MINUTES:-15}"
RUN_TESTS="${RUN_TESTS:-0}"
GIT_TOKEN="${GIT_TOKEN:-}"
APP_DIR=/opt/hoelni-updates
DATA_DIR=/var/lib/hoelni-updates
CONF_DIR=/etc/hoelni-updates
SVC_USER=hoelni-updates

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root (e.g. 'sudo bash' or in the container console)"
command -v apt-get >/dev/null || fail "this installer supports Debian/Ubuntu containers (apt-get not found)"
command -v systemctl >/dev/null || fail "systemd is required"

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git build-essential python3 >/dev/null
# Android app of the agent (scripts/build-android.mjs) – optional, releases are built without it too
apt-get install -y -qq default-jdk-headless aapt zipalign apksigner clang lld zip unzip >/dev/null \
  || echo "warning: Android build tools not installed – the Android app will not be built"

NODE_MAJOR=0
if command -v node >/dev/null; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v), npm $(npm -v)"

say "Service user and directories"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP_DIR" "$DATA_DIR" "$CONF_DIR"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR" "$CONF_DIR"
chmod 700 "$CONF_DIR"

# git with the token only for this process (never stored in .git/config)
git_auth() {
  if [ -n "$GIT_TOKEN" ]; then
    git -c credential.helper= -c "credential.helper=!f() { echo username=x-access-token; echo password=$GIT_TOKEN; }; f" "$@"
  else
    git "$@"
  fi
}

say "Fetching the update server ($BRANCH)"
if [ -d "$APP_DIR/repo/.git" ]; then
  git_auth -C "$APP_DIR/repo" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR/repo" checkout --quiet --force "origin/$BRANCH"
else
  git_auth clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR/repo"
fi
cd "$APP_DIR/repo/update-server"
npm ci --omit=dev --no-audit --no-fund --silent

cat >/usr/local/bin/hoelni-updates <<EOF
#!/bin/sh
# runs the update server CLI as its service user
export HOELNI_UPDATES_CONFIG=$CONF_DIR/config.json
if [ "\$(id -u)" -eq 0 ]; then exec runuser -u $SVC_USER -- /usr/bin/env HOME=$DATA_DIR HOELNI_UPDATES_CONFIG=$CONF_DIR/config.json node $APP_DIR/repo/update-server/src/cli.mjs "\$@"; fi
exec node $APP_DIR/repo/update-server/src/cli.mjs "\$@"
EOF
chmod 755 /usr/local/bin/hoelni-updates

FIRST_RUN=0
if [ ! -f "$CONF_DIR/config.json" ]; then
  FIRST_RUN=1
  say "Creating configuration, signing key and admin token"
  INIT_ARGS=(--repo "$REPO" --branch "$BRANCH" --host "$HOST" --port "$PORT" --channel "$CHANNEL" --auto-build-minutes "$AUTO_BUILD_MINUTES" --data-dir "$DATA_DIR")
  [ "$RUN_TESTS" = "1" ] && INIT_ARGS+=(--run-tests)
  [ -n "$GIT_TOKEN" ] && INIT_ARGS+=(--git-token "$GIT_TOKEN")
  INIT_OUT="$(hoelni-updates init "${INIT_ARGS[@]}")"
fi

say "systemd service"
cat >/etc/systemd/system/hoelni-updates.service <<EOF
[Unit]
Description=Hoelni Client Suite update server
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Environment=HOELNI_UPDATES_CONFIG=$CONF_DIR/config.json
Environment=HOME=$DATA_DIR
Environment=LANG=C.UTF-8
WorkingDirectory=$DATA_DIR
ExecStart=/usr/bin/env node $APP_DIR/repo/update-server/src/cli.mjs serve
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR $CONF_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl stop hoelni-updates 2>/dev/null || true

if [ "${NO_BUILD:-0}" != "1" ]; then
  say "Building the current version (clones the repository, npm ci + build – takes a few minutes)"
  hoelni-updates build --if-changed || echo "Build failed – see the message above; retry with: hoelni-updates build"
fi

systemctl enable --quiet hoelni-updates
systemctl start hoelni-updates

say "Done"
if [ "$FIRST_RUN" = "1" ]; then
  echo "$INIT_OUT"
  echo
  if [ "$HOST" = "127.0.0.1" ]; then
    echo "Distributed through the backend: signed-in suites switch to https://<backend>/updates automatically."
  else
    echo "In the suite: Settings → Updates → enter the update URL, compare the key fingerprint, connect."
  fi
else
  hoelni-updates info
fi
echo
echo "Status page:   http://<container-ip>:$PORT/"
echo "Commands:      hoelni-updates build | list | promote <channel> <build> | attach-installer <build> <file.exe> | info"
echo "Logs:          journalctl -u hoelni-updates -f"
