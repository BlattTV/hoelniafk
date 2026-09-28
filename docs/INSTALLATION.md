# Installation – Hoelni Client Suite und Update-Server

Diese Anleitung führt in zwei Teilen zum laufenden System:

* **Teil A – Client auf deinem Windows-PC:** das Programm mit eigenem Fenster und Tray-Symbol,
  den AFK-Sessions und dem echten Minecraft über „Open game“.
* **Teil B – Update-Server im Proxmox-LXC:** baut jede neue Version automatisch und verteilt sie
  signiert an deine Clients.

Teil B ist optional, aber empfohlen: Danach aktualisierst du die Clients mit einem Klick.

---

## Teil A – Client unter Windows installieren

### A1. Voraussetzungen

| Was | Warum |
|---|---|
| Windows 10 oder 11, 64 Bit | Zielsystem |
| **Node.js 22 LTS** (x64) von <https://nodejs.org> | Laufzeit der Suite. Im Installer den Haken **„Automatically install the necessary tools“** gesetzt lassen. |
| **Git** von <https://git-scm.com/download/win> | Code herunterladen |
| ca. 3 GB freier Speicher | Suite, Minecraft-Dateien und Java (lädt „Open game“ beim ersten Mal herunter) |
| Grafikkarte mit aktuellem Treiber | für das echte Minecraft-Fenster |

Die Suite läuft immer unter **dem Windows-Benutzer, der sie eingerichtet hat**. Der Tresor-Schlüssel
ist per DPAPI an diesen Benutzer gebunden. Richte sie also unter dem Konto ein, das sie später auch
nutzt.

Prüfen in einer **neuen** PowerShell:

```powershell
node -v    # v22.x
git --version
```

### A2. Code holen und bauen

```powershell
cd C:\
git clone https://github.com/BlattTV/hoelniafk.git
cd hoelniafk
git checkout claude/practical-hopper-o4bpyw
npm ci
npm run build
```

Bei einem privaten Repository fragt Git nach Zugangsdaten. Melde dich mit deinem GitHub-Konto an
oder verwende einen Token.

### A3. Das Programm (Installer) bauen und installieren

```powershell
cd C:\hoelniafk\desktop
npm install
npm run dist
```

Danach liegt in `C:\hoelniafk\desktop\release\` die Datei **`Hoelni Client Suite Setup 0.2.0.exe`**.

1. Doppelklick und installieren. Den Installationsordner kannst du ändern; das Programm wird nur
   für deinen Benutzer installiert und braucht keine Admin-Rechte.
2. Windows SmartScreen meldet „Unbekannter Herausgeber“, weil der Installer nicht signiert ist.
   Klicke auf *Weitere Informationen → Trotzdem ausführen*.
3. Im Startmenü erscheint **Hoelni Client Suite**. Beim Start öffnet sich das Programmfenster, und
   unten rechts erscheint das Tray-Symbol (Grasblock).

**Wichtig zum Verhalten:**

* Das Fenster zu schließen beendet das Programm **nicht**. Die AFK-Sessions laufen im Tray weiter.
* *Rechtsklick auf das Tray-Symbol → Sessions* zeigt alle Sessions mit **Open game**,
  **Back to AFK** und **Start/Stop**.
* *Tray → Start with Windows* startet das Programm bei der Anmeldung minimiert im Tray.
* *Tray → Quit* fährt alles sauber herunter. Die Sessions merken sich ihren Soll-Zustand und kommen
  beim nächsten Start von selbst wieder.
* Deine Daten (Datenbank, Tresor, Logs, Minecraft-Installation) liegen unter
  `%APPDATA%\Hoelni Client Suite\data`. *Tray → Open data folder* öffnet den Ordner.

**Ohne Installer**, direkt aus dem Repository:

```powershell
cd C:\hoelniafk\desktop
npm install
npm start
```

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
7. Optional:
   * **Schedules:** Online-Zeitfenster pro Session festlegen, z. B. werktags 18–24 Uhr.
   * **Settings & vault → This PC:** Desktop-Benachrichtigungen und Hell-/Dunkelmodus.

Mehr zu OAuth-Apps (Discord, Microsoft- und Google-Mail) und zu den Netzwerkprofilen:
[SETUP.md](../SETUP.md) und [NETWORKING.md](../NETWORKING.md).

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
  --rootfs local-lvm:8 \
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
* **Per Oberfläche:** *Create CT* → Template Debian 12, 2 Kerne, 2048 MB RAM, 8 GB Disk,
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
| Neuen Windows-Installer beilegen | Installer (Teil A3) in den Container kopieren, dann `hoelni-updates attach-installer <build> "<datei>.exe" 0.2.0`. Die Clients zeigen danach einen Download-Link. |

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
