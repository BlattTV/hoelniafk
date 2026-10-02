# Installation – Hoelni Client Suite, Update-Server, Backend und Agent

Diese Anleitung führt in fünf Teilen zum laufenden System:

* **Teil A – Client auf deinem Windows-PC:** das Programm mit eigenem Fenster und Tray-Symbol,
  den AFK-Sessions und dem echten Minecraft über „Open game“.
* **Teil B – Update-Server im Proxmox-LXC:** baut jede neue Version automatisch und verteilt sie
  signiert an deine Clients.
* **Teil C – Backend `afk.hoelni.de` im Proxmox-LXC:** Konten, Anmeldungen von Manager und Agents
  und die Verbindung zwischen ihnen.
* **Teil D – Hoelni Agent auf PCs in anderen Haushalten:** einmal anmelden, danach führt dieser PC
  AFK-Sessions deines Kontos aus.
* **Teil E – Neue Identität in drei Schritten:** eine Microsoft-Anmeldung für Outlook und Minecraft,
  Discord mit eigenem Fenster pro Identität.

Teil B ist optional, aber empfohlen: Danach aktualisierst du die Clients mit einem Klick.
Teil C brauchst du, sobald Agents oder mehrere Konten ins Spiel kommen.

```
  Dein PC: Manager (Hoelni Client Suite)  ──┐
                                             ├──  wss://afk.hoelni.de  (Backend im LXC)
  Anderer Haushalt: Hoelni Agent  ───────────┘
      └─ führt die Sessions aus, die du ihm in der Suite zuweist ("Run on")
```

---

## Teil A – Client unter Windows installieren

### A1. Voraussetzungen

| Was | Warum |
|---|---|
| Windows 10 oder 11, 64 Bit | Zielsystem |
| ca. 3 GB freier Speicher | Suite, Minecraft-Dateien und Java (lädt „Spiel öffnen“ beim ersten Mal herunter) |
| Grafikkarte mit aktuellem Treiber | für das echte Minecraft-Fenster |

Node.js, Git oder Build-Werkzeuge brauchst du **nicht** – der Installer bringt alles mit.

Die Suite läuft immer unter **dem Windows-Benutzer, der sie eingerichtet hat**. Der Tresor-Schlüssel
ist per DPAPI an diesen Benutzer gebunden. Richte sie also unter dem Konto ein, das sie später auch
nutzt.

### A2. Installer herunterladen

Der Update-Server im LXC baut die Installer selbst (Teil B), das Backend bietet sie an:

**<https://afk.hoelni.de/download>** – dort liegen **Hoelni Client Suite** und **Hoelni Agent**,
jeweils mit Version und SHA-256-Prüfsumme.

Solange dort „Noch nicht gebaut“ steht: im Update-Server-LXC `hoelni-updates build-installers`
ausführen (dauert ca. 5 Minuten) und die Seite neu laden.

### A3. Installieren

1. `Hoelni-Client-Suite-Setup-….exe` starten. Den Installationsordner kannst du ändern; das Programm
   wird nur für deinen Benutzer installiert und braucht keine Admin-Rechte.
2. Windows SmartScreen meldet „Unbekannter Herausgeber“, weil der Installer nicht signiert ist.
   Klicke auf *Weitere Informationen → Trotzdem ausführen*.
3. Im Startmenü erscheint **Hoelni Client Suite**. Beim Start öffnet sich das Programmfenster, und
   unten rechts erscheint das Tray-Symbol.

**Danach nie wieder neu bauen oder installieren:** Die Suite holt sich jede neue Version selbst
(*Einstellungen → Updates*). Das gilt auch für das Programmfenster, das Tray-Menü und die
Minecraft-Fenstersteuerung – sie kommen mit jedem Update mit und sind nach dem nächsten Start der
Suite aktiv. Einen neuen Installer brauchst du nur bei einem Electron-Wechsel; die Suite sagt dir
dann Bescheid, und er liegt wieder unter `/download`.

**Wichtig zum Verhalten:**

* Das Fenster zu schließen beendet das Programm **nicht**. Die AFK-Sessions laufen im Tray weiter.
* *Rechtsklick auf das Tray-Symbol → Sessions* zeigt alle Sessions mit **Spiel öffnen**,
  **Zurück zu AFK** und **Start/Stop**.
* *Tray → Mit Windows starten* startet das Programm bei der Anmeldung minimiert im Tray.
* *Tray → Beenden* fährt alles sauber herunter. Die Sessions merken sich ihren Soll-Zustand und kommen
  beim nächsten Start von selbst wieder.
* Deine Daten (Datenbank, Tresor, Logs, Minecraft-Installation) liegen unter
  `%APPDATA%\Hoelni Client Suite\data`. *Tray → Datenordner öffnen* öffnet den Ordner.

<details><summary>Für Entwickler: aus dem Repository starten oder selbst bauen</summary>

Voraussetzungen: Node.js 22 LTS (ab 22.13) oder 24 und Git.

```powershell
git clone https://github.com/BlattTV/hoelniafk.git
cd hoelniafk
git checkout claude/practical-hopper-o4bpyw
npm ci
npm run build
cd desktop
npm install
npm start                                   # ohne Installer starten
node ..\scripts\build-installers.mjs        # beide Installer → hoelniafk\release\
```

</details>

### A4. Erste Einrichtung im Programm

1. **Settings & vault → Recovery kit exportieren.** Speichere die Datei offline und notiere die
   Passphrase getrennt davon. Ohne das Kit sind die Zugangsdaten auf einem anderen PC oder Benutzer
   nicht wiederherstellbar.
2. **Setup check** öffnen. Die Seite listet alles, was noch fehlt.
3. **Servers:** deinen Minecraft-Server eintragen (Host, Port, Version – oder leer für automatisch).
4. **New identity:** den Assistenten für **eine** Identität durchlaufen, in dieser Reihenfolge:
   Mail → Minecraft (Microsoft-Anmeldung per Code auf microsoft.com/link) → Discord → Netzwerk → Server.
5. In **Accounts × servers** die Session auf *online* setzen, per Klick auf die Zelle.
6. **Open game** in der Session-Zeile (oder `Strg`+`K` → „open game …“): Beim ersten Mal wird
   Minecraft in der Server-Version heruntergeladen. Danach übernimmt das echte Spiel die laufende
   Session – ohne neuen Login. **Back to AFK** oder das Spiel zu schließen gibt die Session an den
   AFK-Client zurück.
7. **Backend:** Hast du Teil C erledigt, meldest du die Suite unter *Settings & vault → Backend & account*
   an (Details in C5).
8. Optional:
   * **Schedules:** Online-Zeitfenster pro Session festlegen, z. B. werktags 18–24 Uhr.
   * **Settings & vault → This PC:** Desktop-Benachrichtigungen und Hell-/Dunkelmodus.

Mehr zu den Netzwerkprofilen: [NETWORKING.md](../NETWORKING.md). Entwickler-Apps (Azure, Discord,
Google) brauchst du **keine**.

### A5. Ohne echten Account ausprobieren

```powershell
cd C:\hoelniafk
npm run demo
```

Dann <http://127.0.0.1:7421> im Browser öffnen. Die Demo startet drei lokale Testserver mit
Beispiel-Identitäten. **Open game** lädt Minecraft 1.20.1 und übernimmt eine Session auf dem lokalen
Server – das ist auch der schnellste Test, ob das echte Spielfenster auf deinem PC funktioniert.

---

## Teil B – Update-Server im Proxmox-LXC aufsetzen

### B1. Container anlegen

In der **Proxmox-Shell** (Knoten → Shell):

```bash
pveam update
pveam available --section system | grep debian-12          # Namen der aktuellen Vorlage ablesen
pveam download local debian-12-standard_12.7-1_amd64.tar.zst # Namen ggf. anpassen

pct create 210 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname hoelni-updates \
  --cores 2 --memory 2048 --swap 512 \
  --rootfs local-lvm:12 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --features nesting=1 \
  --onboot 1
pct start 210
```

Anmerkungen zu den Werten:

* **`210`** ist die Container-ID; nimm eine freie. `local-lvm` und `vmbr0` passt du an deinen Speicher
  und deine Bridge an.
* **Feste IP statt DHCP:** `ip=192.168.1.50/24,gw=192.168.1.1`. Alternativ im Router eine
  DHCP-Reservierung anlegen. Die Clients merken sich die URL, deshalb sollte die IP stabil bleiben.
* **Per Oberfläche:** *Create CT* → Template Debian 12, 2 Kerne, 2048 MB RAM, 12 GB Disk,
  *Unprivileged* und *Nesting* an.

### B2. Update-Server mit einem Befehl installieren

In den Container wechseln:

```bash
pct enter 210
```

Dann, als root im Container:

```bash
apt-get update && apt-get install -y curl
curl -fsSL https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/update-server/install.sh | bash
```

**Bei einem privaten Repository** brauchst du einen GitHub-Token mit Leserecht:

1. GitHub → *Settings → Developer settings → Fine-grained tokens* → neuer Token.
2. Nur für das Repository `BlattTV/hoelniafk`, Berechtigung **Contents: Read-only**.
3. Befehl mit Token ausführen:

```bash
TOKEN=github_pat_XXXX
curl -fsSL -H "Authorization: token $TOKEN" \
  https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/update-server/install.sh \
  | GIT_TOKEN=$TOKEN bash
```

Das Skript läuft einige Minuten. Es installiert Node.js 22, Git und Build-Werkzeuge, legt den Dienst
`hoelni-updates` an, erzeugt den Signierschlüssel und baut die aktuelle Version. Am Ende steht:

```
Update URL:      http://192.168.1.50:8787
Key fingerprint: 0771:4160:f88e:5eee:5a49:e91d:154e:b25e
Admin token:     ....  (shown once)
```

**Fingerprint und Admin-Token notieren.** Das Token wird nur dieses eine Mal angezeigt.

Optionen setzt du als Variablen vor `bash`, z. B. `... | BRANCH=main PORT=8787 AUTO_BUILD_MINUTES=10 bash`:

| Variable | Standard | Bedeutung |
|---|---|---|
| `BRANCH` | `claude/practical-hopper-o4bpyw` | Branch, aus dem gebaut wird (nach dem Merge: `main`) |
| `PORT` | `8787` | HTTP-Port |
| `AUTO_BUILD_MINUTES` | `15` | Wie oft der Branch auf neue Commits geprüft wird (`0` = nur manuell) |
| `RUN_TESTS` | `0` | `1` = Unit-Tests vor jeder Veröffentlichung |

### B3. Prüfen

Im Browser <http://IP-des-Containers:8787/> öffnen. Die Statusseite zeigt den Fingerprint und das
erste Release, z. B. `#1  0.2.0+1.abc1234  [stable]`.

Im Container:

```bash
systemctl status hoelni-updates      # läuft?
journalctl -u hoelni-updates -f      # Logs live
hoelni-updates list                  # Releases
```

### B4. Client mit dem Update-Server verbinden

> **Mit Backend (Teil C) entfällt dieser Schritt:** Läuft der Update-Server im Backend-Container (C6),
> richtet sich die Suite nach der Anmeldung am Backend selbst ein. Die folgenden Schritte gelten nur für
> einen eigenen Update-Container im LAN ohne Backend.

1. Im Programm: **Settings & vault → Updates**.
2. **URL** eintragen, z. B. `http://192.168.1.50:8787`, und auf **Connect** klicken.
3. Den angezeigten **Fingerprint** mit dem aus B2 vergleichen. Nur wenn beide gleich sind:
   *Fingerprint matches – trust this server*.

Ab jetzt:

* Der Client prüft alle 6 Stunden auf neue Versionen. Liegt eine vor, steht links in der Seitenleiste
  **„Update … ready“**.
* **Install update** lädt das Update, prüft Signatur und Prüfsumme und startet kurz neu. Die Sessions
  kommen danach von selbst zurück.
* Startet die neue Version nicht sauber, stellt das Programm die alte automatisch wieder her.
  *Roll back last update* macht das auch von Hand.
* Optional **Install automatically** aktivieren. Das Update wird dann nur installiert, solange kein
  Spielfenster offen ist.

### B5. Betrieb und Wartung

| Aufgabe | Befehl im Container |
|---|---|
| Sofort bauen (statt zu warten) | `hoelni-updates build` |
| Releases und Kanäle anzeigen | `hoelni-updates list` |
| Update-Server selbst aktualisieren | den Installationsbefehl aus B2 erneut ausführen |
| Neues Admin-Token | `hoelni-updates rotate-token && systemctl restart hoelni-updates` |
| Windows-Installer | Baut der Update-Server selbst, sobald sich etwas daran ändert (Electron-Version, Starter, Icons). Sofort neu bauen: `hoelni-updates build-installers`. Angeboten unter `https://afk.hoelni.de/download`. |

**Backup:** Sichere `/etc/hoelni-updates/` (enthält den **Signierschlüssel**) und
`/var/lib/hoelni-updates/`, z. B. mit dem normalen Proxmox-Backup des Containers. Geht der Schlüssel
verloren, erzeugt eine Neuinstallation einen neuen. Jeder Client muss dann unter
*Settings & vault → Updates → Reconnect* den neuen Fingerprint bestätigen.

**Netzwerk:** Der Dienst gehört ins LAN. Gib Port 8787 nicht ins Internet frei. Falls du ihn doch von
außen brauchst: Reverse-Proxy mit TLS davor. Die Signatur schützt die Updates auch über reines HTTP.

### B6. Wenn etwas nicht klappt

| Problem | Lösung |
|---|---|
| `curl: (22) … 404` beim Installationsbefehl | Branch- oder Dateiname falsch, oder das Repository ist privat → Token-Variante aus B2 verwenden |
| Build schlägt fehl (`npm ci`) | `journalctl -u hoelni-updates -n 100` lesen. Häufig: zu wenig RAM → Container auf 2048 MB. Danach `hoelni-updates build`. |
| Client: „signature is INVALID“ | Falscher Server oder neu erzeugter Schlüssel → Fingerprint vergleichen, dann *Reconnect* |
| Client: „key is not confirmed“ | *Connect* in *Settings & vault → Updates* ausführen und den Fingerprint bestätigen |
| Client findet den Server nicht | IP und Port prüfen, `curl http://IP:8787/health` vom PC aus. Windows-Firewall und VLANs prüfen. |
| Update installiert, aber alte Version aktiv | Die neue Version ist abgestürzt und wurde zurückgerollt. Unter *Updates → Last problem* steht der Grund. |


---

## Teil C – Backend `afk.hoelni.de` im Proxmox-LXC

Das Backend verwaltet die **Konten**: dein Admin-Konto sowie Konten für Freunde. Es verwaltet außerdem
die **Anmeldungen** von Manager und Agents und leitet zwischen ihnen weiter. Minecraft-Zugangsdaten
und Tokens liegen weiterhin nur im Tresor der Suite; das Backend sieht sie nie gespeichert.
Passwörter der Konten speichert es nur als scrypt-Hash, Geräte-Tokens nur als SHA-256.

### C1. Container anlegen

Wie in B1, nur mit anderem Namen und weniger Ressourcen. 1 Kern und 512 MB RAM reichen:

```bash
pct create 211 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname hoelni-backend \
  --cores 1 --memory 512 --swap 256 \
  --rootfs local-lvm:4 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.51/24,gw=192.168.1.1 \
  --unprivileged 1 --features nesting=1 \
  --onboot 1
pct start 211
```

Die feste IP (hier `192.168.1.51`) passt du an dein Netz an. Der Router leitet später auf sie weiter.

### C2. Domain und Router vorbereiten

Das Backend muss **aus dem Internet** erreichbar sein, denn die Agents sitzen in anderen Haushalten.

1. **DNS:** Lege bei deinem Domain-Anbieter für `afk.hoelni.de` einen **A-Record** auf deine
   öffentliche IPv4 an, bei IPv6 zusätzlich einen AAAA-Record auf die IPv6 des Containers.
   Hast du eine wechselnde IP, nutze DynDNS (z. B. über die Fritzbox) und lege für `afk` einen
   **CNAME** auf deinen DynDNS-Namen an.
2. **Router-Portfreigabe** auf die Container-IP `192.168.1.51`:
   * Variante *caddy* (Standard): **TCP 80 und TCP 443**. Port 80 braucht Let's Encrypt für das Zertifikat.
   * Variante *self*: nur **TCP 443**.
   * Variante *proxy*: keine neue Freigabe; dein vorhandener Reverse-Proxy leitet weiter.

Prüfen: `nslookup afk.hoelni.de` muss deine öffentliche IP liefern.

### C3. Backend mit einem Befehl installieren

```bash
pct enter 211
```

Im Container, Standardvariante mit Let's-Encrypt-Zertifikat über Caddy:

```bash
apt-get update && apt-get install -y curl
curl -fsSL https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/backend/install.sh | DOMAIN=afk.hoelni.de bash
```

Ist das Repository privat, brauchst du einen GitHub-Token mit Lesezugriff:

```bash
curl -fsSL -H "Authorization: token DEIN_TOKEN" \
  https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/backend/install.sh \
  | GIT_TOKEN=DEIN_TOKEN DOMAIN=afk.hoelni.de bash
```

Der Installer:

1. installiert Node.js 22 und Caddy;
2. legt den Dienstbenutzer `hoelni-backend` an;
3. richtet den systemd-Dienst ein;
4. holt das HTTPS-Zertifikat;
5. **fragt nach Namen und Passwort deines Admin-Kontos**. Das Passwort braucht mindestens 10 Zeichen und wird beim Tippen nicht angezeigt.

Am Ende gibt er eine Übersicht mit `hoelni-backend info` aus.

**Andere Varianten** (Umgebungsvariable `TLS=`):

| Variante | Wann | Befehl |
|---|---|---|
| `caddy` (Standard) | Domain zeigt auf dich, 80/443 sind frei | `… \| DOMAIN=afk.hoelni.de bash` |
| `proxy` | Du hast schon Nginx Proxy Manager, Traefik o. ä. auf 80/443 | `… \| TLS=proxy DOMAIN=afk.hoelni.de bash` – dann im Proxy: `afk.hoelni.de` → `http://192.168.1.51:8480`, **WebSocket-Support an**, SSL-Zertifikat dort anfordern |
| `self` | Keine Domain / kein Let's Encrypt möglich | `… \| TLS=self DOMAIN=afk.hoelni.de bash` – eigenes Zertifikat; Manager und Agent zeigen beim ersten Anmelden den Fingerabdruck, den du mit `hoelni-backend info` vergleichst |

Den Installer kannst du jederzeit erneut ausführen. Er **aktualisiert** das Backend und behält
Konfiguration, Datenbank und Zertifikat.

### C4. Prüfen

```bash
systemctl status hoelni-backend        # active (running)
curl -s https://afk.hoelni.de/health   # {"ok":true,"service":"hoelni-backend",…}
hoelni-backend info                    # Konten, angemeldete Geräte, ggf. Fingerabdruck
```

Von einem Handy **im Mobilfunknetz** (nicht im WLAN) `https://afk.hoelni.de/health` öffnen. Erscheint
`{"ok":true…}`, ist das Backend von außen erreichbar.

### C5. Manager (deine Suite) anmelden

In der Suite: **Settings & vault → Backend & account**.

1. Die Adresse steht schon auf `https://afk.hoelni.de`. Ändern kann sie nur ein Admin des aktuellen
   Backends (*Change address…*).
2. Admin-Benutzername und Passwort eingeben → **Sign in**. Bei der Variante *self* erscheint vorher
   der Fingerabdruck: mit `hoelni-backend info` vergleichen und bestätigen.
3. Danach zeigt die Karte *connected · admin*. In der linken Leiste erscheint **Accounts**; der
   Eintrag ist nur für Admins sichtbar.

**Konten anlegen:** *Accounts → New account* mit Benutzername, Passwort und Rolle. Dort kannst du auch
Passwörter zurücksetzen, Konten sperren oder löschen und angemeldete Manager/Agents einzeln
**widerrufen**. Das wirkt sofort: Das Gerät wird getrennt und muss sich neu anmelden.
Alternativ im Container: `hoelni-backend user add <name>` bzw. `user passwd`, `user disable`, `user list`, `devices`.

Hinweise:

* Pro Konto ist **ein Manager** gleichzeitig aktiv. Meldet sich ein zweiter an, übernimmt er.
* Ohne verbundenen Manager führen die Agents nichts aus. Sessions laufen nur, solange die Suite läuft.
* **Proxy zum Backend:** Muss der Manager selbst über einen Proxy ins Internet, trägst du ihn in derselben
  Karte ein (`socks5://…` oder `http://…`). Er wird im Tresor gespeichert und nur maskiert angezeigt.
* **Übernommen von einem anderen Manager?** In der Karte auf *Reconnect* klicken, um wieder zu übernehmen.

### C6. Updates über das Backend verteilen

Statt eines eigenen Update-Containers (Teil B) kann der Update-Server **im Backend-Container** laufen.
Er ist dort nur lokal erreichbar (`127.0.0.1:8787`). Das Backend gibt seine signierten Releases unter
`https://afk.hoelni.de/updates` weiter, und zwar **nur an Geräte, die an deinem Backend angemeldet
sind**. Eine weitere Portfreigabe oder einen weiteren Proxy-Host brauchst du nicht.

1. Dem Container **2 GB RAM** und **12 GB Disk** geben, denn der Build (`npm ci` + TypeScript) und
   die Windows-Installer brauchen das: auf dem Proxmox-Host `pct set 211 --memory 2048` und
   `pct resize 211 rootfs 12G`. Die ID ersetzt du durch deine.
2. Im Container den Installer erneut ausführen, mit `UPDATES=1` und deiner bisherigen Variante
   (hier `TLS=proxy` für Nginx Proxy Manager):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/BlattTV/hoelniafk/claude/practical-hopper-o4bpyw/backend/install.sh \
     | TLS=proxy UPDATES=1 DOMAIN=afk.hoelni.de bash
   ```

   Bei privatem Repository wie in C3 mit `-H "Authorization: token …"` und `GIT_TOKEN=…`. Den Token
   braucht der Update-Server auch später, um neue Versionen zu bauen.
   Der erste Build dauert einige Minuten. Am Ende steht der **Fingerabdruck des Signaturschlüssels**
   in der Ausgabe; später zeigt `hoelni-updates info` ihn erneut.
3. Prüfen:

   ```bash
   hoelni-backend info        # "Updates: https://afk.hoelni.de/updates → http://127.0.0.1:8787"
   hoelni-updates list        # mindestens ein Build im Kanal stable
   ```

4. **In der Suite:** nichts einzutragen. Sobald die Suite am Backend angemeldet und verbunden ist,
   stellt sie ihre Update-Quelle **automatisch** auf `https://afk.hoelni.de/updates` um. Den
   Signaturschlüssel übernimmt sie über die geprüfte HTTPS-Verbindung zu deinem Backend, und eine
   vorher eingetragene LAN-Adresse (z. B. `http://192.168.x.x:8787`) wird ersetzt. Unter
   *Einstellungen & Tresor → Updates* siehst du Quelle und Fingerabdruck; vergleichen kannst du ihn mit
   `hoelni-updates info`. *Update installieren* installiert mit Neustart, bei Problemen rollt die Suite zurück.

Neue Versionen baut der Update-Server automatisch aus dem Branch, standardmäßig alle 15 Minuten.
Von Hand geht es mit `hoelni-updates build`.

### C7. Betrieb und Wartung

| Aufgabe | Befehl |
|---|---|
| Logs live | `journalctl -u hoelni-backend -f` |
| Neustart | `systemctl restart hoelni-backend` |
| Update | Installationsbefehl aus C3 erneut ausführen |
| Sicherung | Datei `/var/lib/hoelni-backend/backend.db` (plus `/etc/hoelni-backend/`) sichern – oder den Container per Proxmox-Backup |
| Admin-Passwort vergessen | `hoelni-backend user passwd <name>` im Container |

### C8. Wenn etwas nicht klappt

| Problem | Lösung |
|---|---|
| Caddy bekommt kein Zertifikat | DNS zeigt noch nicht auf dich (`nslookup`), Port 80 nicht weitergeleitet, oder der Provider blockiert 80 → Variante `proxy` oder `self` |
| Suite: „Backend not reachable“ | `curl https://afk.hoelni.de/health` vom PC; Router-Freigabe und Firewall prüfen |
| Suite: „did not confirm the admin account“ | Beim Adresswechsel wurden keine gültigen Admin-Daten des **aktuellen** Backends angegeben |
| Suite: *another manager of this account took over* | Ein zweiter Manager mit demselben Konto hat sich verbunden – dort abmelden |
| „Too many failed sign-ins“ | 10 Fehlversuche von derselben Adresse → 10 Minuten warten |
| Nginx Proxy Manager zeigt **502 Bad Gateway**, `hoelni-backend info` zeigt `127.0.0.1:8480` | Backend wurde in der Variante *caddy* installiert und lauscht nur lokal → Installer erneut mit `TLS=proxy` ausführen (stellt auf `0.0.0.0` um und schaltet Caddy ab) |
| Updates: „401“ in der Update-Karte | Die Suite ist nicht (mehr) am Backend angemeldet → *Backend & account* → *Sign in* |
| Updates: „502“ / „Update server not reachable“ | `systemctl status hoelni-updates` im Container; der Build läuft evtl. noch → `journalctl -u hoelni-updates -f` |
| Hinter Nginx Proxy Manager: Agents verbinden nicht | Im Proxy-Host **Websockets Support** einschalten |

---

## Teil D – Hoelni Agent auf PCs in anderen Haushalten

Der Agent ist ein kleines Windows-Programm. Wer es installiert und sich mit einem Hoelni-Konto
anmeldet, stellt diesen PC dem **Manager desselben Kontos** zur Verfügung. Dort starten dann
AFK-Sessions, die du in der Suite diesem Agent zuweist.

**Was der Agent darf:** Minecraft-Sessions des Kontos starten und stoppen, Chat, auf Wunsch das
Minecraft-Spielfenster öffnen. **Was er nicht darf:** Befehle ausführen, Dateien lesen, den Bildschirm
übertragen. Der Haushalt sieht im Fenster und im Tray, was läuft, und kann jederzeit **pausieren**.
Alles läuft dann über die Internetleitung dieses Haushalts, außer die Identität hat einen Proxy
(siehe D4).

**Schutz des Haushalts:** Der Agent prüft jeden Befehl selbst. Er verbindet sich nur zu **öffentlichen**
Servern und Proxys. Adressen im Heimnetz (z. B. `192.168.x.x`, Router, NAS) oder auf dem PC selbst
lehnt er ab. Einstellungen wie Version und Speicher prüft er auf erlaubte Werte.
Bind-IP-Netzwerkprofile funktionieren nur auf deinem eigenen PC. Eine Identität, die auf einem Agent
laufen soll, bekommt keinen oder einen Proxy.

**Microsoft-Konten:** Läuft eine Identität mit Microsoft-Anmeldung auf einem Agent, bekommt dieser PC
für die Dauer der Session das Minecraft-Zugangstoken im Arbeitsspeicher. Anders kann der Agent sich
nicht am Server anmelden. Weise solche Identitäten deshalb nur Haushalten zu, denen du vertraust.

### D1. Installer holen

Den Agent-Installer baut der Update-Server automatisch. Du gibst dem anderen Haushalt einfach den Link
**<https://afk.hoelni.de/download>** (in der Suite unter *Erweitert → Agents* mit „Link kopieren“).
Dort lädt er **Hoelni Agent** herunter. Ein Konto zum Anmelden bekommt er von dir (D2).

Nach der Installation aktualisiert sich der Agent selbst (D5), inklusive seines Fensters.

### D2. Beim anderen Haushalt installieren

1. `Hoelni-Agent-Setup-….exe` ausführen. Die Installation läuft ohne Admin-Rechte, nur für diesen Windows-Benutzer.
2. Im Fenster **Benutzername** und **Passwort** des Kontos eingeben. Du legst es unter *Accounts* an;
   es kann auch dein eigenes Konto sein. Optional einen Namen wie „Wohnzimmer-PC“ vergeben.
3. **Anmelden**. Zeigt das Fenster einen Fingerabdruck (nur bei Variante *self*), vergleichst du
   ihn mit `hoelni-backend info` und klickst auf *Fingerabdruck stimmt – anmelden*.
4. Fertig. Der Agent startet künftig mit Windows und läuft im Tray; das lässt sich abschalten.

Das Passwort wird nicht gespeichert. Der Agent behält nur ein Geräte-Token, verschlüsselt mit
Windows DPAPI und damit an diesen Windows-Benutzer gebunden.

### D3. Sessions auf dem Agent laufen lassen

In deiner Suite:

1. **Agents** (linke Leiste) zeigt den neuen PC: *online*, *paused by household* oder *offline*.
2. Identität öffnen → **Identity Settings → Run on → „Agent: Wohnzimmer-PC“** → *Save settings*.
3. Session starten wie gewohnt. Sie läuft jetzt auf dem Agent; Chat, Status und Belohnungen siehst du
   wie bei lokalen Sessions.
4. **Open game** öffnet das echte Minecraft-Fenster **auf dem Agent-PC**. Minecraft wird dort beim
   ersten Mal heruntergeladen.

Ist der Agent offline oder pausiert, wartet die Session. Sie startet, sobald er wieder verfügbar ist.

### D4. Proxy-Pool

**Proxy pool** (linke Leiste, *Setup*):

1. **Import:** Liste einfügen, eine Zeile pro Proxy. Erlaubt sind `socks5://user:pass@host:port`,
   `http://host:port`, `host:port:user:pass` und `host:port`. Die Passwörter landen direkt im
   verschlüsselten Tresor und werden nie wieder angezeigt.
2. **Test all:** prüft jeden Proxy und zeigt Exit-IP und Latenz. Proxys mit derselben Exit-IP werden markiert.
3. **Assign automatically:** Jede Identität ohne Pool-Proxy bekommt einen funktionierenden Proxy mit
   einer Exit-IP, die keine andere Identität nutzt. Einzeln geht es über *assign to…* in der Tabelle.

Der zugewiesene Proxy wird zum Netzwerkprofil der Identität. Er gilt auch dann, wenn die Identität
auf einem Agent läuft: Die Verbindung geht vom Agent-PC über den Proxy zum Minecraft-Server.

**Proxy für die Verbindung des Agents zum Backend** (z. B. in Firmennetzen): im Agent unter
*Einstellungen → Proxy für die Verbindung zum Server*.

### D5. Updates

Der Agent aktualisiert sich selbst, über dieselben signierten Releases wie die Suite:

1. Voraussetzung: Das Backend verteilt Updates. `hoelni-backend info` zeigt dann
   `Updates: https://afk.hoelni.de/updates → http://127.0.0.1:8787`. Falls dort *not distributed*
   steht und der Update-Server im selben LXC läuft:
   `hoelni-backend config set updatesUpstream http://127.0.0.1:8787` und
   `systemctl restart hoelni-backend`.
2. Du baust wie gewohnt mit `hoelni-updates build`.
3. Der Agent prüft alle 6 Stunden, eine Minute nach dem Start auch sofort. Er lädt das Update,
   prüft Signatur und Prüfsumme und installiert es, **sobald auf dem PC nichts läuft**. Laufen dort
   ständig Sessions, installiert er es spätestens nach 6 Stunden trotzdem; die Sessions verbinden
   sich dann nach wenigen Sekunden neu. Solange das Minecraft-Fenster offen ist, installiert er nie.
4. Startet die neue Version nicht, stellt das Agent-Fenster automatisch die vorherige wieder her.

Im Agent-Fenster steht unten die Build-Nummer, z. B. `v0.4.0 · Build 57`, und ob ein Update wartet.
Den Signaturschlüssel übernimmt der Agent bei der ersten Prüfung über die geschützte Verbindung
zum Backend. Ändert er sich später, lehnt der Agent Updates ab, bis er neu angemeldet wird.

### D6. Wenn etwas nicht klappt

| Problem | Lösung |
|---|---|
| Agent: „Wrong username or password“ | Konto unter *Accounts* prüfen bzw. Passwort zurücksetzen |
| Agent: „abgemeldet“ | Zugang wurde widerrufen oder das Passwort des Kontos geändert → neu anmelden |
| Agent „verbunden“, aber „Verwaltung gerade offline“ | Deine Suite läuft nicht oder ist nicht am Backend angemeldet |
| Suite: „Agent … is offline“ bei einer Session | PC aus, Agent beendet oder keine Internetverbindung dort |
| Suite: „Agent … is paused by the household“ | Im Agent-Fenster wurde *Pausieren* gedrückt |
| Suite: „Agent refused: … local/private address“ | Server oder Proxy der Identität liegt in einem privaten Netz. Agents verbinden nur zu öffentlichen Adressen. |
| Suite: „Agent refused: Bind-IP network profiles …“ | Der Identität statt der Bind-IP einen Proxy oder kein Netzwerkprofil geben |
| Session auf dem Agent: Proxy-Fehler | *Proxy pool → Test* für diesen Proxy; ggf. *Release* und neu zuweisen |
| Agent-Fenster zeigt keine neue Build-Nummer | `hoelni-backend info` → Zeile *Updates* prüfen (D5); Log: `%APPDATA%\Hoelni Agent\logs\agent.log` |

### D7. Agent als Android-App (Handy)

Ein Android-Handy kann ebenfalls Agent sein. Die App enthält denselben Agent wie das Windows-Programm,
mit eigenem Node.js, und lässt die AFK-Sessions im Hintergrund laufen, auch bei ausgeschaltetem
Bildschirm.

**Einmalig auf dem Update-Server** (LXC aus Teil B; neu installierte Container haben das schon):

```bash
apt-get install -y default-jdk-headless aapt zipalign apksigner dalvik-exchange clang lld zip unzip
hoelni-updates build-installers      # baut die APK sofort, sonst mit dem nächsten "hoelni-updates build"
```

Ab dann baut der Update-Server die APK bei jedem Release mit. Die Downloadseite
**<https://afk.hoelni.de/download>** bietet sie als **Hoelni Agent für Android** an. Beim ersten Bau
entsteht der Signaturschlüssel `/var/lib/hoelni-updates/android/release.p12` (+ `.pass`). **Sichere
beide Dateien.** Android installiert neue Versionen nur über eine App mit demselben Schlüssel. Ohne
den Schlüssel müsste jede Person die App erst deinstallieren und sich neu anmelden.

**Auf dem Handy:**

1. <https://afk.hoelni.de/download> im Handy-Browser öffnen → *Hoelni Agent für Android* → **Herunterladen**.
2. Die APK öffnen. Android fragt einmal, ob der Browser Apps installieren darf → **erlauben** → **Installieren**.
   Play Protect warnt evtl., weil die App nicht aus dem Play Store kommt → *Trotzdem installieren*.
3. App öffnen, **Benachrichtigungen erlauben**. Die dauerhafte Meldung „Hoelni Agent läuft“ hält den Agent am Leben.
4. Mit **Benutzername** und **Passwort** des Kontos anmelden (wie D2) und einen Gerätenamen vergeben.
5. Erscheint der Hinweis *Akku-Optimierung ist an* → **Im Hintergrund erlauben** → *Zulassen*.
6. In der Suite erscheint das Handy wie ein PC unter **Agents**. Bei einer Identität bzw. pro Server
   **Läuft auf → „Agent: <Gerätename>“** wählen.

**Gut zu wissen:**

- Am besten **am Ladekabel und im WLAN**. Eine AFK-Session braucht wenig Daten, aber dauerhaft.
- Manche Hersteller (Xiaomi, Huawei, Samsung, OnePlus …) beenden Hintergrund-Apps zusätzlich. Dort in
  den App-Einstellungen *Autostart* erlauben bzw. Akku auf *Nicht optimiert/Uneingeschränkt* stellen.
  Anleitungen je Hersteller: <https://dontkillmyapp.com>.
- Nach einem Neustart des Handys startet der Agent von selbst. Der Schalter oben in der App schaltet
  ihn ganz aus; *Pausieren* hält nur die Sessions an (wie D3).
- **„Spiel öffnen“ geht auf dem Handy nicht.** Die Suite meldet dann „only be opened on a PC“, die
  AFK-Session läuft weiter.
- Voraussetzung: Android 7 oder neuer auf einem 64-Bit-Handy (arm64). Das sind praktisch alle Geräte
  seit etwa 2017.
- **Updates:** Gibt es eine neue Version, zeigt die App oben *Neue Version verfügbar* →
  **Herunterladen & installieren**. Die Anmeldung bleibt erhalten.
- Das Geräte-Token liegt verschlüsselt in der App. Der Schlüssel dafür steckt im Android-Keystore
  des Handys.
- Protokoll: in der App unter *Protokoll & Einstellungen*.

---

## Teil E – Neue Identität in drei Schritten (Microsoft + Discord)

Kostenlos und ohne App-Registrierung: kein Azure, keine Client-ID, keine Discord-Entwickler-App.

In der Suite: **Neue Identität** (links oben).

1. **Name & Server:** Name eingeben, Server anhaken, *Weiter*.
2. **Mit Microsoft anmelden:** Die E-Mail-Adresse des Microsoft-Kontos dieser Identität eingeben
   (outlook.com / hotmail / live) und auf *Mit Microsoft anmelden* klicken.
   * Es öffnet sich das **Microsoft-Fenster dieser Identität** mit Microsofts eigener Minecraft-Bestätigung.
     Der Code ist schon eingetragen. Du meldest dich dort an und bestätigst.
   * Danach ist **Minecraft** verbunden (Name und UUID werden übernommen).
   * **Outlook** öffnet sich im selben Fenster und ist schon angemeldet, weil es derselbe Microsoft-Login ist.
     Ab dann: *Outlook öffnen* auf der Identitätsseite oder links unter **Outlook**.
   * Jede Identität hat ihr eigenes Microsoft-Fenster mit eigenem Login. Konten vermischen sich nie.
3. **Discord:** *Discord-Konto erstellen* oder *Ich habe schon eins – anmelden*. Discord öffnet sich in
   einem **eigenen Fenster nur für diese Identität**.
   * E-Mail-Adresse, Benutzername und ein sicheres Passwort liegen zum Kopieren bereit. Das Passwort
     erzeugt die Suite einmal und legt es im Tresor ab; angezeigt wird es nie.
   * Das Formular füllst du selbst aus. Discord verbietet automatisierte Registrierungen, deshalb
     schickt die Suite nichts selbst ab.
   * Die Bestätigungs-Mail von Discord kommt in **Outlook** an. Ein Klick auf den Link öffnet ihn
     automatisch im Discord-Fenster dieser Identität.
   * Zum Schluss **Fertig – Konto ist eingerichtet** klicken. Den Discord-Namen kannst du dabei für die
     Übersicht eintragen.
4. **Fertig → Jetzt online schalten.**

**Wechseln:** Die Seiten **Discord** und **Outlook** zeigen alle Konten. Ein Klick öffnet das Fenster dieser
Identität.

**Optional – IMAP-Postfächer:** Wer Verifizierungs-Codes automatisch in der Suite sehen will, kann unter
*Erweitert → Postfächer & Aliase* ein Postfach mit Passwort eintragen (z. B. GMX, web.de, eigener
Mailserver, Gmail mit App-Passwort). Für Outlook ist das nicht nötig.

Die Microsoft- und Discord-Fenster gibt es im **Desktop-Programm**. Im normalen Browser öffnen sich die
Seiten in neuen Tabs; dort teilen sich die Identitäten aber einen Login.

Alles Weitere (Netzwerkprofile, Vorlagen, Zeitpläne, Proxy-Pool, Server, Logs …) steht links unter
**Erweitert**. Auf der Identitätsseite sind die Details unter *Details & Einstellungen* eingeklappt.

---

### E4. Zugänge: Konten einzeln anlegen und selbst verknüpfen

Unter **Zugänge** (linke Leiste) legst du Microsoft- und Discord-Konten unabhängig von Identitäten an:

1. **Microsoft-Konto hinzufügen:** E-Mail eintragen → es öffnet sich ein eigenes Fenster für dieses
   Konto, dort bei Microsoft anmelden. **Discord-Konto hinzufügen:** optional Name/Benutzername →
   im eigenen Fenster registrieren oder anmelden → *Fertig – eingerichtet*.
2. In der Spalte **Identität** das Konto einer Identität zuweisen. Hat die Identität schon ein Konto
   dieser Art, geht das alte zurück in die Zugänge.
3. Umhängen auf eine andere Identität geht genauso. Der Minecraft-Login des Microsoft-Kontos zieht
   verschlüsselt mit; „– nicht verknüpft –“ löst das Konto, es bleibt mit seiner Anmeldung erhalten.

Auf der Seite einer Identität geht dasselbe über *„… aus den Zugängen verknüpfen“* bzw. *Trennen*.
Jedes Konto behält sein eigenes Browserprofil – Outlook und Discord bleiben angemeldet, egal zu
welcher Identität es gerade gehört. Bestehende Anmeldungen wurden beim Update automatisch übernommen.

## Teil F – Automatische Session-Erneuerung und Makro-Builder

### F1. Abgelaufene Session: läuft einfach weiter

Normalerweise zeigt Minecraft nach Ablauf der Session „Invalid session (Try restarting your game and
the launcher)“. Dann musst du Spiel und Launcher neu starten und neu verbinden. In der Suite passiert
das im Hintergrund:

* Meldet der Server eine abgelaufene Session („Invalid session“, „Failed to verify username“,
  abgelaufene Chat-Signaturschlüssel), holt die Suite **sofort** ein frisches Minecraft-Token und
  neue Chat-Schlüssel aus deiner gespeicherten Microsoft-Anmeldung und verbindet neu, ohne Wartezeit.
* **Das echte Spiel bleibt offen und verbunden.** Während der AFK-Client neu verbindet, wartet das Spiel
  und zeigt „Hoelni: … reconnecting…“. Sobald die neue Verbindung steht, wechselt es in die neue Welt,
  so wie bei einem Serverwechsel über einen Proxy.
* Dasselbe gilt für Server-Neustarts, Verbindungsabbrüche und Serverwechsel über Proxys wie Velocity.
* Blockiert wird nur, wenn zwei Erneuerungen hintereinander nicht helfen. Kommt die Session innerhalb
  von 5 Minuten nicht zurück, schließt die Suite das Spiel mit einem Hinweis.

Einstellbar ist das in `config/rules.yaml` (Regel `session expired`, Aktion `renew`).

### F2. Makro-Builder

Links unter **Makros**. Du baust Abläufe aus Blöcken zusammen wie in Scratch:

* **Auslöser (Kopfblock):**
  * manuell
  * wenn die Session online ist
  * wenn der Chat einen Text enthält (auch als Regex)
  * alle X Sekunden
  * jeden Tag um HH:MM
  * wenn das Leben unter einen Wert fällt
* **Steuerung:** warten, warten bis der Chat etwas enthält, wiederholen, fortlaufend wiederholen,
  falls/dann/sonst, Makro stoppen.
  * Mögliche Bedingungen: Chat enthält, Leben unter, Hunger unter, Inventar hat, Zufall.
* **Bewegung:** gehen (mit Sprint), springen, schleichen, drehen, in eine Richtung schauen.
* **Aktionen:** Hand schwingen, Gegenstand benutzen (Rechtsklick), Mob in der Nähe angreifen, Hotbar-Slot wählen.
* **Chat:** sagen, Befehl.
* **Suite:** Notiz ins Protokoll.
* **Variablen:** „setze“ / „ändere um“, zum Beispiel als Zähler, abfragbar in Bedingungen („Variable ≥ 5“).
* **Weitere Steuerung:** zufällig warten (von–bis), warten bis eine Bedingung erfüllt ist, wiederhole bis.
* **Weitere Aktionen:** Gegenstand in die Hand nehmen, essen, gehaltenen Gegenstand wegwerfen,
  angeschauten Block abbauen, zum nächsten Spieler schauen.
* **Weitere Bedingungen:** Spieler in der Nähe, Nacht im Spiel, echte Uhrzeit zwischen, Variable vergleichen.
* **Weitere Auslöser:** wenn Hunger unter, wenn der Spieler gestorben ist, wenn ein Spieler näher kommt.
* **Platzhalter** in Chat-, Befehls- und Notiz-Texten: `{health}` `{food}` `{x}` `{y}` `{z}` `{time}` `{name}`
  und Variablen wie `{counter}`.

**Bedienung:**
* Blöcke aus der Palette ins Skript ziehen oder anklicken, um sie anzuhängen.
* Verschieben geht per Ziehen. Zum Löschen den Block auf die Palette ziehen oder auf das × klicken.
* Oben legst du fest, für welche Identitäten und Server das Makro gilt. Leer bedeutet alle.
* **Speichern** wirkt sofort auch in laufenden Sessions.
* **Ausführen** testet das Makro auf einer Online-Session. Die Ausführungen stehen unten im Protokoll.

**Was die Makros tun:**
* Makros laufen direkt am AFK-Client, auch auf Agents, und **pausieren automatisch**, solange du
  selbst im echten Spiel steuerst.
* Sie nutzen nur normale Spieleraktionen. Mit *menschlichem Timing* (Standard) variieren Wartezeiten
  und Aktionen leicht, mit kleinen Pausen dazwischen.
* Im Spiel erscheint nichts von der Suite: keine Mod, keine Chat-Ausgaben außer denen, die du selbst
  als Block einbaust.
* Schleifen ohne Pause lässt die Suite nicht zu, damit kein Makro den Server mit Paketen flutet.
