# Hoelni Client Suite

Integrierte **Minecraft / Discord / Mail Identity Management Suite** für den eigenen
Minecraft-Server und selbst kontrollierte Testumgebungen.

```
Identity
├── Minecraft Account ─┬─ Session → Server A     (desired ONLINE/OFFLINE, eigener Netzwerkpfad)
│                      ├─ Session → Server B
│                      └─ …
├── Mail (Mailbox / Alias, Verification Mail)
├── Discord (OAuth2, Link-Status zum Server)
├── Network Profile (Bind-IP / Proxy, erwartete Exit-IP, Guard)
└── Rewards / Stars (pro Server)
```

## Dokumentation

| Datei | Inhalt |
|---|---|
| [SETUP.md](SETUP.md) | Vom frischen Windows bis zur laufenden Suite, OAuth-Apps, Betrieb, Updates |
| [NETWORKING.md](NETWORKING.md) | Windows-Bind-IPs → OPNsense → VPN → Exit-VPS mit mehreren IPv4, Troubleshooting |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Tatsächlich implementierte Architektur, Session-Lebenszyklus, Sicherheitsmodell |
| [FINAL_STATUS.md](FINAL_STATUS.md) | Was implementiert / getestet ist, was Zugangsdaten braucht, Grenzen |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Messwerte 1–100 Sessions (generiert von `npm run bench`) |
| [docs/DISCORD.md](docs/DISCORD.md) | Discord-Integration, Bewertung Provisional Accounts |

## Schnellstart

```bash
npm ci
npm run build
npm start                 # supervised → http://127.0.0.1:7420
```

Ohne echte Accounts ausprobieren (echte Sessions gegen drei lokale Testserver):

```bash
npm run demo              # → http://127.0.0.1:7421
```

## Kernfunktionen

* **Minecraft-Runtime:** mineflayer-Sessions in überwachten Runtime-Host-Prozessen
  (Crash → Neustart, Heartbeats), Desired-State-Reconciler mit regelbasierter Reconnect-Policy,
  Lightweight-AFK-Modus, **interaktive 3D-Spielansicht derselben laufenden Session**
  (öffnen/verstecken ohne Reconnect, Maus/Tastatur-Steuerung).
* **Multi-Account × Multi-Server:** derselbe Account gleichzeitig auf mehreren Servern,
  Account × Server-Matrix, Bulk-Operationen, Global Chat.
* **Netzwerk:** Bind-IP / SOCKS5 / HTTP-Proxy pro Identity oder Session, Public-IP-Prüfung,
  Netzwerk-Guard (Start blockieren bei Mismatch), Schritt-für-Schritt-Diagnose.
* **Mail:** IMAP (Passwort / OAuth2 Microsoft & Google), SMTP, Inbox, Global Inbox,
  Verification-Mail-Erkennung per Regeln, Codes kopierbar, Aliase (Plus-Addressing, Cloudflare).
* **Discord:** OAuth2 (PKCE) für bestehende Accounts, benutzergeführte Registrierung,
  Link-Status/Codes aus dem Server-Chat.
* **Rewards/Stars:** pro Identity und Server (Stars, eligible, received, waiting, Discord linked,
  Historie) – alles über `config/rules.yaml`.
* **Sicherheit:** AES-256-GCM-Vault (DPAPI / Credential Manager), nur Referenzen in SQLite,
  Recovery-Kit, Identity-Isolation, redigierte Logs, Audit-Log, lokale API mit Token/CSP.
* **Betrieb:** Supervisor, Session-Restore nach Neustart, strukturierte Logs, Monitoring,
  Setup-Check, DB-Migrationen mit Backup, tägliche DB-Backups.

## Tests

```bash
npm run typecheck
npm run test:unit          # MOCK
npm run test:integration   # LOCAL INTEGRATION: mineflayer↔flying-squid, Runtime-Prozesse,
                           # Bind-IP/Proxys, IMAP/SMTP, OAuth2+PKCE über HTTP, Spielansicht
npm test                   # beides
npm run test:e2e           # Browser (Playwright) gegen die Demo; einmalig: npx playwright install chromium
npm run bench              # Performance 1–100 Sessions → docs/PERFORMANCE.md
```

Real-Service- und Real-Account-Tests benötigen deine Zugangsdaten – siehe [FINAL_STATUS.md](FINAL_STATUS.md).

## Weitere Befehle

```bash
npm run vault -- status | export-recovery --out kit.json | recover --kit kit.json
npm run testserver -- --port 25601 --count 1     # lokaler Offline-Testserver
```
