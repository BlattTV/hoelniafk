# Hoelni Client Suite

Integrierte **Minecraft / Discord / Mail Identity Management Suite** für den eigenen
Minecraft-Server und selbst kontrollierte Testumgebungen.

```
Identity
├── Minecraft Account ─┬─ Session → Server A     (desired ONLINE/OFFLINE, eigener Netzwerkpfad)
│                      ├─ Session → Server B
│                      └─ …
├── Mail (Mailbox / Alias, Verification Mail)
├── Discord (eigenes Fenster pro Identität, Link-Status zum Server)
├── Network Profile (Bind-IP / Proxy, erwartete Exit-IP, Guard)
└── Rewards / Stars (pro Server)
```

## Dokumentation

| Datei | Inhalt |
|---|---|
| **[docs/INSTALLATION.md](docs/INSTALLATION.md)** | **Schritt für Schritt: Client unter Windows, Update-Server und Backend `afk.hoelni.de` im Proxmox-LXC, Hoelni Agent für andere Haushalte** |
| [SETUP.md](SETUP.md) | Vom frischen Windows bis zur laufenden Suite, Betrieb, Updates |
| [NETWORKING.md](NETWORKING.md) | Windows-Bind-IPs → OPNsense → VPN → Exit-VPS mit mehreren IPv4, Troubleshooting |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Tatsächlich implementierte Architektur, Session-Lebenszyklus, Sicherheitsmodell |
| [FINAL_STATUS.md](FINAL_STATUS.md) | Was implementiert / getestet ist, was Zugangsdaten braucht, Grenzen |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Messwerte 1–100 Sessions (generiert von `npm run bench`) |
| [docs/DISCORD.md](docs/DISCORD.md) | Discord-Integration, Bewertung Provisional Accounts |

## Schnellstart

Desktop-Programm (eigenes Fenster + Tray, Windows-Installer):

```bash
npm ci && npm run build
cd desktop && npm install
npm start                 # Programmfenster direkt aus dem Repository
npm run dist              # Windows-Installer → desktop/release/
```

Nur das Backend (z. B. als Autostart-Dienst): `npm start` (supervised, 127.0.0.1:7420).

Ohne echte Accounts ausprobieren (echte Sessions gegen drei lokale Testserver):

```bash
npm run demo              # → http://127.0.0.1:7421
```

## Kernfunktionen

* **Backend & Agents:** Konten und Geräte-Anmeldungen laufen über das Backend (`afk.hoelni.de`,
  `backend/`). Die Kontoverwaltung sitzt in der Suite und ist nur für Admins sichtbar.
  Der **Hoelni Agent** (`agent-app/`, Windows-Installer) meldet sich mit demselben Konto an.
  Danach führt dieser PC die Sessions aus, die du ihm zuweist (*Run on*); das Spielfenster öffnet sich dort.
* **Proxy-Pool:** Proxy-Listen importieren und testen (Exit-IP, Latenz), dann automatisch je Identität
  einen Proxy mit eigener Exit-IP zuweisen. Das gilt auch für Sessions auf Agents.

* **Minecraft-Runtime:** mineflayer-Sessions in überwachten Runtime-Host-Prozessen
  (Crash → Neustart, Heartbeats), Desired-State-Reconciler mit regelbasierter Reconnect-Policy,
  Lightweight-AFK-Modus.
* **„Open game“ = echtes Minecraft:** eigener Launcher für den offiziellen Java-Client
  (Vanilla/Fabric, Java-Runtime von Mojang). Standardmodus **Live-Takeover**: das echte Spiel
  übernimmt die *laufende* AFK-Session – dieselbe Serververbindung, kein neuer Login; Spiel
  schließen / „Back to AFK“ gibt die Session an den AFK-Client zurück. Normales Fenster
  (Alt-Tab), normale Steuerung, Inventar, HUD. Alternativ Handover (Re-Login) oder
  Background (Spiel hält die Session minimiert).
* **Zeitpläne:** Online-Fenster pro Session im Wochenraster (z. B. werktags 18–24 Uhr), manueller
  Start überstimmt bis zum nächsten Wechsel, ein offenes Spiel wird nie abgeschnitten.
* **Programm-Komfort:** Tray-Menü mit allen Sessions (Open game / Back to AFK / Start / Stop),
  Desktop-Benachrichtigungen (Session blockiert, Link-Code, Update), Schnellaktionen mit `Strg`+`K`,
  Hell-/Dunkelmodus.
* **Multi-Account × Multi-Server:** derselbe Account gleichzeitig auf mehreren Servern,
  Account × Server-Matrix, Bulk-Operationen, Global Chat.
* **Netzwerk:** Bind-IP / SOCKS5 / HTTP-Proxy pro Identity oder Session, Public-IP-Prüfung,
  Netzwerk-Guard (Start blockieren bei Mismatch), Schritt-für-Schritt-Diagnose.
* **Mail:** Outlook im Microsoft-Fenster jeder Identität; optional IMAP (Passwort), SMTP, Inbox, Global Inbox,
  Verification-Mail-Erkennung per Regeln, Codes kopierbar, Aliase (Plus-Addressing, Cloudflare).
* **Discord:** eigenes Fenster pro Identität (ohne Entwickler-App), benutzergeführte Registrierung,
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
                           # Bind-IP/Proxys, IMAP/SMTP, Launcher, Open game/Takeover
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
