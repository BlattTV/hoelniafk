# Hoelni Client Suite

Integrierte **Minecraft / Discord / Mail Identity Management Suite** für den eigenen
Minecraft-Server und selbst kontrollierte Testumgebungen.

Die zentrale Verwaltungseinheit ist die **Identity**:

```
IdentityProfile
├── MinecraftIdentity      Microsoft-/Offline-Account, UUID, Auth-Status
├── MailIdentity           Adresse (ggf. Alias) auf einer realen Mailbox
├── DiscordIdentity        per OAuth2 verbundener Discord-Account + Link-Status
├── NetworkProfile[]       Bind-IP / SOCKS5 / HTTP-Proxy, erwartete Exit-IP
├── RewardState            Stars, Eligible, Historie
└── SessionInstances[]     je Server eine Session (Account, Server, Network, Chat, State)
```

## Schnellstart

Voraussetzung: Node.js ≥ 20 (Windows empfohlen, Linux/macOS funktionieren ebenfalls).

```bash
npm install
npm run build
npm start                 # → http://127.0.0.1:7420
```

* Die Oberfläche lauscht **nur auf 127.0.0.1**. Jeder Start erzeugt ein neues API-Token,
  das ausschließlich in die ausgelieferte Seite eingebettet wird.
* Konfiguration (ohne Secrets): `config/app.example.yaml` → `config/app.yaml` kopieren.
* Erkennungsregeln (Mails, Link-Codes, Stars): `config/rules.yaml`.

**Demo ohne echte Accounts** (simulierte Sessions, Mailbox, Discord, Exit-IPs, 15 Identities):

```bash
npm run demo              # → http://127.0.0.1:7421
```

**Tests:**

```bash
npm test                  # vitest – u. a. Isolation, Vault, Regeln, Audit, API-Sicherheit
npm run typecheck
```

## Credential Vault

* Secrets werden AES-256-GCM-verschlüsselt in `data/vault.json` gespeichert; die Credential-Ref
  ist dabei *Additional Authenticated Data* – ein Eintrag lässt sich nicht auf eine andere
  Identity „umkopieren“.
* Der Master-Key wird geschützt durch
  * **Windows DPAPI** (Standard unter Windows, `vault.keyProvider: auto|dpapi`) oder
  * **Windows Credential Manager** (`credman`, via `@napi-rs/keyring`) oder
  * eine Passphrase (`HOELNI_VAULT_PASSPHRASE`, für Linux/Headless).
* SQLite (`data/hoelni.db`) enthält **ausschließlich Referenzen** wie
  `vault://identity/7/mail`, `vault://identity/7/minecraft`, `vault://mailbox/3`.
* Die GUI zeigt Passwörter/Tokens nie an; Eingabefelder für Secrets sind Write-only.
* Logs und Audit-Log laufen durch einen Redaction-Filter; Codes werden im Audit-Log maskiert (`AB****`).

## OAuth-Apps einrichten

Redirect-URI für alle Provider: `http://127.0.0.1:7420/oauth/callback`
(in der UI unter *Settings & Vault* kopierbar). Client-IDs und -Secrets werden in der UI
eingetragen; Secrets landen im Vault.

| Provider  | Zweck | Scopes |
|-----------|-------|--------|
| Discord   | bestehenden Discord-Account mit einer Identity verbinden | `identify` |
| Microsoft | Outlook/Hotmail-Mailbox per IMAP/SMTP (XOAUTH2) | `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access` |
| Google    | Gmail per IMAP/SMTP (XOAUTH2) | `https://mail.google.com/` |

Alle Flows nutzen Authorization Code + PKCE; der `state` ist einmalig und an die Identity gebunden.

## Discord – was die Suite tut und was nicht

* **Verbinden** bestehender Accounts nur über den offiziellen OAuth2-Flow.
* **CREATE DISCORD ACCOUNT** öffnet nur die offizielle Registrierung im Browser
  (`https://discord.com/register`); der Benutzer registriert und verifiziert selbst und
  verbindet den Account danach per OAuth2. Keine Self-Bots, keine automatisierte
  Account-Erstellung, keine Automatisierung normaler Benutzerkonten.
* Einschätzung zu *Discord Provisional Accounts*: siehe [docs/DISCORD.md](docs/DISCORD.md).

## Minecraft ↔ Discord Linking

Der generische `LinkingWorkflow` beobachtet nur den Chat der Sessions:
`UNKNOWN → WAITING (Link-Code erkannt) → LINKED (Erfolgsmeldung) / ERROR`.
Welche Nachrichten Code/Erfolg/Fehler bedeuten, steht ausschließlich in `config/rules.yaml`
(`chatRules`, Typ `linking`). Der Code wird im Dashboard angezeigt und kann kopiert werden;
der Benutzer führt den vorgesehenen Link-Vorgang selbst aus.

## Funktionen im Überblick

| Bereich | Umsetzung |
|---|---|
| Identity Dashboard | Tabelle mit Minecraft/Discord/Mail/Exit-IP/Stars/Health, Mehrfachauswahl |
| Identity-Ansicht | Minecraft, Discord, Mail (Inbox), Network, Sessions, Rewards, Settings, Audit; Health-Checks anklickbar |
| Setup Wizard | Step 1–6 (Mail, Minecraft, Discord, Network, Server, Verification) mit READY-Checkliste |
| Health Check | HEALTHY / WARNING / ERROR; Meilenstein „alles grün“ (Minecraft, Mail, Discord, Discord Link, Exit IP, Session) |
| Mail Manager | IMAP (Passwort) oder OAuth2, Suche, Absender-/Betreff-Filter, unread/read, HTML (sandboxed, Remote-Bilder blockiert)/Text, Links, Anhänge, manuelle Zuordnung |
| Verification Mail | regelbasierte Erkennung (Discord, Microsoft, Minecraft, Hoelni), Codes anzeigen & kopieren |
| Mail-Aliase | `MailProvider` mit `listAliases/createAlias/deleteAlias/listMessages/getMessage`; Adapter: Plus-Addressing, Cloudflare Email Routing (offizielle API) |
| Global Inbox | ALL MAIL mit Filtern Identity / Provider / unread / verification / security |
| Global Operations | Check Mail, Verify Network, Start/Stop Sessions, Reconnect, Verify Discord, Open Discord, Open Mail – für die Auswahl |
| Templates | z. B. „Default AFK Identity“ (Network-Modus, Server, AutoReconnect, Mail, Discord-Linking, AFK, Parser) |
| Identity Clone | übernimmt Serverzuweisungen, Network-Regeln, AFK, Parser, UI – **keine** Credentials/Accounts/IPs |
| Sessions | mineflayer; mehrere Server pro Identity gleichzeitig; Network-Profil pro Identity oder pro Session überschreibbar; Auto-Reconnect mit Backoff; Chat-Ansicht |
| Monitoring / Automation | zyklische Mail-, Netzwerk- und Discord-Prüfung, Auto-Start (`config/app.yaml`), Live-Updates per SSE |
| Audit Log | sicherheitsrelevante Aktionen, ohne Tokens/Passwörter/vollständige Codes |

## Isolation

Jede Ressource ist einer Identity zugeordnet und wird beim Zugriff geprüft
(`IsolationError`, HTTP 403). Automatisierte Tests in `tests/isolation.test.ts` stellen sicher,
dass eine Identity niemals Mailbox/Mails, Discord-Verknüpfung, NetworkProfile oder
Minecraft-Token einer anderen Identity verwendet. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Entwicklungsphasen

Stand und Vorgehen: [docs/ROADMAP.md](docs/ROADMAP.md).
