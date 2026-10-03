#!/bin/sh
# Installs the Hoelni Agent as a service (systemd). Run from the unpacked folder:
#   sudo ./install.sh
# Afterwards:  sudo hoelni-agent login --user NAME --name "Name dieses Rechners"
# Remove:      sudo /opt/hoelni-agent/agent-linux/uninstall.sh
set -e
SRC=$(dirname "$(readlink -f "$0")")
[ "$(basename "$SRC")" = agent-linux ] && SRC=$(dirname "$SRC")
TARGET=/opt/hoelni-agent
DATA=/var/lib/hoelni-agent

if [ "$(id -u)" != 0 ]; then echo "Please run with sudo: sudo ./install.sh" >&2; exit 1; fi
command -v systemctl >/dev/null 2>&1 || { echo "No systemd found. Without a service: ./hoelni-agent login … and ./hoelni-agent run" >&2; exit 1; }

echo "› service user hoelni-agent"
id hoelni-agent >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin hoelni-agent

echo "› files to $TARGET"
if [ "$SRC" != "$TARGET" ]; then
  systemctl stop hoelni-agent 2>/dev/null || true
  mkdir -p "$TARGET"
  # keep downloaded updates / rollback data of an earlier installation
  cp -a "$SRC"/. "$TARGET"/
fi
chown -R hoelni-agent:hoelni-agent "$TARGET"   # the agent updates itself
mkdir -p "$DATA" /etc/hoelni-agent
chown hoelni-agent:hoelni-agent "$DATA"
chmod 700 "$DATA"
[ -f /etc/hoelni-agent/env ] || printf 'HOELNI_AGENT_DIR=%s\n' "$DATA" > /etc/hoelni-agent/env
ln -sf "$TARGET/agent-linux/hoelni-agent" /usr/local/bin/hoelni-agent

echo "› service hoelni-agent.service"
cat > /etc/systemd/system/hoelni-agent.service <<UNIT
[Unit]
Description=Hoelni Agent (AFK sessions for the Hoelni Client Suite)
After=network-online.target
Wants=network-online.target

[Service]
User=hoelni-agent
Group=hoelni-agent
EnvironmentFile=/etc/hoelni-agent/env
WorkingDirectory=$TARGET
ExecStart=$TARGET/node/bin/node $TARGET/agent-linux/supervisor.cjs
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$TARGET $DATA

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now hoelni-agent >/dev/null

echo
echo "Installed. Now sign in this computer with your Hoelni account:"
echo "  sudo hoelni-agent login --user NAME --name \"$(hostname)\""
echo "Status: sudo hoelni-agent status    Log: sudo hoelni-agent log"
