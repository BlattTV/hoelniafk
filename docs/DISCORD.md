> **Stand jetzt:** Die Suite braucht keine Discord-Entwickler-App mehr. Jede Identität hat ihr eigenes
> Discord-Fenster (Desktop-Programm); nach Registrierung/Anmeldung dort markiert man das Konto als
> eingerichtet (optional mit Benutzernamen). Der OAuth2-Abschnitt unten beschreibt die frühere Lösung.

# Discord-Integration

## Umgesetzt

1. **Connect Discord Account (OAuth2)** – Authorization Code + PKCE, Scope `identify`.
   Gespeichert werden `discordUserId`, `username`, `displayName`, `avatar`, `oauthState`,
   `lastVerifiedAt`; der Refresh-Token liegt verschlüsselt unter `vault://identity/<id>/discord`.
2. **CREATE DISCORD ACCOUNT** – benutzergeführt:

   ```
   Klick „Create Discord Account“
          ↓
   offizielle Registrierung https://discord.com/register im Browser
          ↓
   Benutzer registriert & verifiziert selbst (Verifizierungsmail erscheint im Identity-Postfach)
          ↓
   zurück in die Suite → „Connect via OAuth2“
          ↓
   DiscordIdentity wird gespeichert
   ```

   Die Suite erstellt keine Accounts, automatisiert keine Benutzerkonten (keine Self-Bots)
   und nutzt keine inoffiziellen Endpunkte.
3. **Verify** – Refresh-Token → `/users/@me`; abweichende User-ID wird abgelehnt.
4. **Linking-Status zum Minecraft-Server** – generisch über Chat-Regeln (`config/rules.yaml`).

## Untersuchung: Discord Social SDK – Provisional Accounts

> Hinweis: discord.com war aus der Build-Umgebung nicht erreichbar; die folgende Einschätzung
> basiert auf der öffentlichen Beschreibung des Social SDK und sollte vor einer Umsetzung
> gegen die aktuelle Dokumentation geprüft werden:
> https://discord.com/developers/docs/social-sdk/authentication.html

**Was sie sind:** Provisional Accounts sind für Spieler *ohne* Discord-Account gedacht, damit sie
innerhalb eines Spiels, das das Social SDK integriert, soziale Funktionen (z. B. Freunde,
Lobbys, Nachrichten im Spiel) nutzen können. Sie werden über die eigene Authentifizierung des
Spiels bzw. einen externen Identity-Provider der Anwendung angelegt und können später mit einem
vollwertigen Discord-Account zusammengeführt werden.

**Abgrenzung zu normalen Konten:** Sie sind an die jeweilige Anwendung gebunden und keine
normalen Discord-Benutzerkonten – sie sind nicht als Account für den Discord-Client bzw. für
normale Discord-Server gedacht.

**Bewertung für diesen Anwendungsfall:**

* Das Linking-System des eigenen Minecraft-Servers verknüpft Minecraft-Spieler mit *regulären*
  Discord-Usern (typischerweise Mitglieder des Server-Guilds, z. B. für Rollen).
  Provisional Accounts erfüllen diese Rolle voraussichtlich nicht.
* Das Social SDK richtet sich an Spiel-Clients (native SDK) und erfordert eine eigene
  Discord-Anwendung mit entsprechender Freischaltung – für einen Minecraft-Server mit
  Java-Clients/mineflayer-Sessions ist das ein erheblicher Zusatzaufwand ohne Nutzen für das Linking.

**Entscheidung:** nicht umgesetzt. `DiscordIdentity` bleibt auf reguläre, per OAuth2
verbundene Accounts beschränkt. Sollte das Social SDK später relevant werden, kann
`oauthState`/`DiscordIdentity` um einen Kontotyp (`regular` | `provisional`) erweitert werden,
ohne die Isolation (eine Discord-ID je Identity) aufzugeben.
