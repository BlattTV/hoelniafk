#!/usr/bin/env bash
# Hoelni backend (afk.hoelni.de) – installer for a Debian/Ubuntu LXC (Proxmox etc.).
#   accounts, device sign-ins of managers and agents, relay between them
#
# One command (as root in the container):
#   curl -fsSL https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/backend/install.sh | bash
# Private repository: pass a GitHub token (read access):
#   curl -fsSL -H "Authorization: token <TOKEN>" https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/backend/install.sh | GIT_TOKEN=<TOKEN> bash
#
# Options (environment variables):
#   DOMAIN=afk.hoelni.de   public name of the backend
#   TLS=caddy              caddy  – Caddy with a Let's Encrypt certificate (DNS must point here,
#                                   ports 80 + 443 forwarded to this container)
#                          proxy  – you already have a reverse proxy (Nginx Proxy Manager, Traefik …):
#                                   the backend listens on plain HTTP PORT, your proxy terminates TLS
#                                   and forwards (incl. WebSocket) to http://<container-ip>:PORT
#                          self   – own self-signed certificate on port 443 (no domain/Let's Encrypt
#                                   needed; apps confirm the fingerprint once)
#   PORT=8480              internal port of the backend
#   ADMIN=niklas           admin account created on the first install (password is asked)
#   BRANCH / REPO          source of the backend
#
# Running the script again upgrades the backend and keeps config, database and certificates.
set -euo pipefail

REPO="${REPO:-https://github.com/BlattTV/hoelniafk.git}"
BRANCH="${BRANCH:-claude/practical-hopper-o4bpyw}"
DOMAIN="${DOMAIN:-afk.hoelni.de}"
TLS="${TLS:-caddy}"
PORT="${PORT:-8480}"
ADMIN="${ADMIN:-}"
GIT_TOKEN="${GIT_TOKEN:-}"
APP_DIR=/opt/hoelni-backend
DATA_DIR=/var/lib/hoelni-backend
CONF_DIR=/etc/hoelni-backend
SVC_USER=hoelni-backend

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root (e.g. 'sudo bash' or in the container console)"
command -v apt-get >/dev/null || fail "this installer supports Debian/Ubuntu containers (apt-get not found)"
command -v systemctl >/dev/null || fail "systemd is required"
case "$TLS" in caddy|proxy|self) ;; *) fail "TLS must be caddy, proxy or self" ;; esac

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

# Node.js 22.13+ (built-in SQLite)
NODE_OK=0
if command -v node >/dev/null; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' && NODE_OK=1
fi
if [ "$NODE_OK" != "1" ]; then
  say "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v)"

say "Service user and directories"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP_DIR" "$DATA_DIR" "$CONF_DIR"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR" "$CONF_DIR"
chmod 700 "$DATA_DIR" "$CONF_DIR"

git_auth() {
  if [ -n "$GIT_TOKEN" ]; then
    git -c credential.helper= -c "credential.helper=!f() { echo username=x-access-token; echo password=$GIT_TOKEN; }; f" "$@"
  else
    git "$@"
  fi
}

say "Fetching the backend ($BRANCH)"
if [ -d "$APP_DIR/repo/.git" ]; then
  git_auth -C "$APP_DIR/repo" fetch --quiet --depth 1 origin "$BRANCH"
  git -C "$APP_DIR/repo" checkout --quiet --force FETCH_HEAD
else
  git_auth clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR/repo"
fi
cd "$APP_DIR/repo/backend"
npm ci --omit=dev --no-audit --no-fund --silent

cat >/usr/local/bin/hoelni-backend <<EOF
#!/bin/sh
# backend CLI, runs as the service user
if [ "\$(id -u)" -eq 0 ]; then exec runuser -u $SVC_USER -- /usr/bin/env HOME=$DATA_DIR HOELNI_BACKEND_CONFIG=$CONF_DIR/config.json node $APP_DIR/repo/backend/src/cli.mjs "\$@"; fi
exec /usr/bin/env HOELNI_BACKEND_CONFIG=$CONF_DIR/config.json node $APP_DIR/repo/backend/src/cli.mjs "\$@"
EOF
chmod 755 /usr/local/bin/hoelni-backend

FIRST_RUN=0
if [ ! -f "$CONF_DIR/config.json" ]; then
  FIRST_RUN=1
  say "Creating configuration (TLS mode: $TLS)"
  case "$TLS" in
    caddy) hoelni-backend init --host 127.0.0.1 --port "$PORT" --trust-proxy --data-dir "$DATA_DIR" --public-url "https://$DOMAIN" ;;
    proxy) hoelni-backend init --host 0.0.0.0 --port "$PORT" --trust-proxy --data-dir "$DATA_DIR" --public-url "https://$DOMAIN" ;;
    self)
      openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=$DOMAIN" \
        -addext "subjectAltName=DNS:$DOMAIN" \
        -keyout "$CONF_DIR/key.pem" -out "$CONF_DIR/cert.pem" 2>/dev/null
      chown "$SVC_USER:$SVC_USER" "$CONF_DIR/key.pem" "$CONF_DIR/cert.pem"
      chmod 600 "$CONF_DIR/key.pem"
      PORT=443
      hoelni-backend init --host 0.0.0.0 --port 443 --data-dir "$DATA_DIR" --public-url "https://$DOMAIN" --tls-cert "$CONF_DIR/cert.pem" --tls-key "$CONF_DIR/key.pem"
      ;;
  esac
fi

if [ "$FIRST_RUN" = "0" ] && [ "$TLS" = "proxy" ]; then
  # Switching an existing install to an external reverse proxy (e.g. Nginx Proxy Manager on another host):
  # listen on all interfaces with X-Forwarded-For trust, and stop a Caddy set up by an earlier run.
  say "Reverse-proxy mode: backend listens on 0.0.0.0:$PORT"
  node -e '
    const fs = require("fs"); const f = process.argv[1]; const c = JSON.parse(fs.readFileSync(f, "utf8"));
    c.host = "0.0.0.0"; c.trustProxy = true; c.tls = { cert: "", key: "" };
    fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });' "$CONF_DIR/config.json"
  if [ -f /etc/caddy/sites/hoelni-backend.caddy ]; then
    rm -f /etc/caddy/sites/hoelni-backend.caddy
    systemctl disable --now caddy 2>/dev/null || true
  fi
fi

if [ "$TLS" = "caddy" ]; then
  if ! command -v caddy >/dev/null; then
    say "Installing Caddy (HTTPS with Let's Encrypt)"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
  fi
  say "Caddy site $DOMAIN → 127.0.0.1:$PORT"
  mkdir -p /etc/caddy/sites
  cat >/etc/caddy/sites/hoelni-backend.caddy <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  if ! grep -q 'import sites/\*' /etc/caddy/Caddyfile 2>/dev/null; then
    # Replace Caddy's default welcome page config, keep anything the user added.
    if grep -q '^:80 {' /etc/caddy/Caddyfile 2>/dev/null && grep -q 'root \* /usr/share/caddy' /etc/caddy/Caddyfile; then
      printf '# managed sites\nimport sites/*\n' >/etc/caddy/Caddyfile
    else
      printf '\nimport sites/*\n' >>/etc/caddy/Caddyfile
    fi
  fi
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl enable --quiet caddy
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

say "systemd service"
CAPS=""
[ "$TLS" = "self" ] && CAPS="AmbientCapabilities=CAP_NET_BIND_SERVICE"
cat >/etc/systemd/system/hoelni-backend.service <<EOF
[Unit]
Description=Hoelni backend (accounts + relay)
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Environment=HOELNI_BACKEND_CONFIG=$CONF_DIR/config.json
Environment=HOME=$DATA_DIR
Environment=NODE_NO_WARNINGS=1
WorkingDirectory=$DATA_DIR
ExecStart=/usr/bin/env node $APP_DIR/repo/backend/src/cli.mjs serve
Restart=always
RestartSec=3
$CAPS
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR
ReadOnlyPaths=$CONF_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --quiet hoelni-backend
systemctl restart hoelni-backend

# First admin account (asked interactively – also works with "curl … | bash" through /dev/tty)
if ! hoelni-backend user list 2>/dev/null | grep -q $'\tadmin\t'; then
  if (exec </dev/tty) 2>/dev/null; then
    if [ -z "$ADMIN" ]; then
      printf '\nName of your admin account: ' >/dev/tty
      read -r ADMIN </dev/tty
    fi
    say "Creating admin account \"$ADMIN\""
    hoelni-backend user add "$ADMIN" --admin </dev/tty || echo "Admin not created – run: hoelni-backend user add <name> --admin"
  else
    echo "No terminal – create the admin later: hoelni-backend user add <name> --admin"
  fi
fi

sleep 1
say "Done"
hoelni-backend info
echo
if systemctl is-active --quiet hoelni-backend; then echo "Service:      running"; else echo "Service:      NOT running – journalctl -u hoelni-backend -n 50"; fi
case "$TLS" in
  caddy) echo "Address:      https://$DOMAIN   (DNS A/AAAA record → your public IP, router: forward TCP 80 + 443 to this container)" ;;
  proxy) echo "Address:      https://$DOMAIN   (your reverse proxy → http://<container-ip>:$PORT, enable WebSocket support)" ;;
  self)  echo "Address:      https://$DOMAIN   (router: forward TCP 443 to this container; apps confirm the fingerprint above once)" ;;
esac
echo "Check:        curl -s https://$DOMAIN/health"
echo "Commands:     hoelni-backend info | user add <name> [--admin] | user passwd <name> | user list | devices"
echo "Logs:         journalctl -u hoelni-backend -f"
