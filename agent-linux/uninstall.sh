#!/bin/sh
# Removes the Hoelni Agent service. The data (sign-in) stays in /var/lib/hoelni-agent unless --purge.
set -e
if [ "$(id -u)" != 0 ]; then echo "Please run with sudo" >&2; exit 1; fi
systemctl disable --now hoelni-agent 2>/dev/null || true
rm -f /etc/systemd/system/hoelni-agent.service /usr/local/bin/hoelni-agent
systemctl daemon-reload
rm -rf /opt/hoelni-agent
if [ "$1" = --purge ]; then rm -rf /var/lib/hoelni-agent /etc/hoelni-agent; userdel hoelni-agent 2>/dev/null || true; fi
echo "Hoelni Agent removed${1:+ (with data)}."
