# Entwicklungsphasen

Die Architektur deckt das Zielbild bereits ab; in Betrieb genommen wird schrittweise.

| Phase | Inhalt | Stand |
|---|---|---|
| A | IdentityProfile + SQLite | ✅ Schema, Repository, Migrationen |
| B | MinecraftIdentity | ✅ Microsoft-Device-Code-Login (prismarine-auth), Token im Vault, Offline-Modus für Testserver |
| C | MailIdentity + eine IMAP/OAuth-Mailbox | ✅ IMAP (Passwort) und OAuth2 (Microsoft/Google), Header-Index, Bodies on demand |
| D | Discord OAuth2 | ✅ Connect/Verify/Disconnect, benutzergeführte Registrierung |
| E | NetworkProfile | ✅ Bind-IP, SOCKS5, HTTP-CONNECT, Exit-IP-Verifikation |
| F | eine vollständige Identity | ✅ Health/Meilenstein; Test `tests/identity.test.ts` („Phase F“) |
| G | mehrere Identities | ✅ Dashboard, Bulk-Operationen, Templates, Clone |
| H | Multi-Server | ✅ mehrere Sessions je Identity, Session-Manager je Server |
| I | Monitoring / Automation | ✅ Scheduler (Mail/Netzwerk/Discord), SSE-Live-Updates, Audit |

## Empfohlene Inbetriebnahme (erster Meilenstein)

1. `config/app.yaml` anlegen, Server unter *Servers* eintragen.
2. OAuth-Apps (Discord, ggf. Microsoft/Google) anlegen, Client-IDs in *Settings* eintragen.
3. **Eine** Identity über den Wizard einrichten, bis im Dashboard alles grün ist:

   ```
   Minecraft ✓  Mail ✓  Discord ✓  Discord Link ✓  Exit IP ✓  Session ✓   → READY
   ```

4. Erst danach per Template/Clone auf 15+ Identities skalieren.

## Mögliche nächste Schritte

* Weitere Alias-Adapter (z. B. SimpleLogin, addy.io) über das `AliasManager`-Interface.
* IMAP IDLE statt Polling für sofortige Verifizierungsmails.
* Export/Import von Templates.
* Rules-Editor in der UI (derzeit: `config/rules.yaml` + „Reload rules“).
