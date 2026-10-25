# Bookmarks

Eine sehr schlanke selbst gehostete Bookmark-Startseite. <br>
Daten und Logo werden komplett über die Web-UI verwaltet. Du kannst deinen Bestand jederzeit als JSON exportieren und auf einer anderen Instanz wieder importieren. <br>

<p align="center">
  <video src="https://github.com/user-attachments/assets/dd89f103-2c6f-4418-bdea-1fd56aea3ce8" autoplay loop muted playsinline width="720"></video>
</p>

## Quick Start

```bash
npm install
npm start
```

UI: `http://localhost:8080`. Beim ersten Aufruf ohne `bookmarks.json` siehst du einen Empty-State:

- **JSON hochladen**: eine eigene Bookmark-Datei importieren
- **Beispiel laden**: mit `bookmarks.example.json` starten

Anschließend kannst du in der UI Kategorien und Bookmarks anlegen, bearbeiten und per Drag-and-Drop sortieren. Jede Änderung wird automatisch in `bookmarks.json` gespeichert.

Einstellbar per Umgebungsvariable:

| Variable | Default | Zweck |
|---|---|---|
| `PORT` | `8080` | Port des Servers |
| `HOST` | `0.0.0.0` | Adresse, auf der er lauscht |
| `DATA_DIR` | App-Verzeichnis | Ablage für `bookmarks.json`, `backups/` und das eigene Logo |

## Daten und Logo verwalten

Über das `+`-Symbol unten rechts öffnest du das Fenster für "weitere Bookmarks" und die Möglichkeiten Einstellungen vorzunehmen. Dort findest du:

- **JSON importieren / exportieren / zurücksetzen**
- **Logo ändern** — Hier kannst Du ein eigenes Logo hochladen und verwenden. Mit „Standard wiederherstellen" fällt die Anzeige auf das committete `logo.png` zurück. Das aktuelle Logo wird gleichzeitig als Favicon im Browser-Tab verwendet.
- **Kategorien und lose Bookmarks** — anlegen, bearbeiten, löschen, per Drag-and-Drop sortieren. Pro Kategorie gibt es zwei Häkchen:
  - **Eingeklappt anzeigen** — die Kategorie erscheint als Kachel, die Bookmarks öffnen sich per Klick
  - **In der Seitenleiste unter dem Logo anzeigen** — auf breiten Bildschirmen (ab 1440 px) steht die Kategorie im freien Bereich unter dem Logo, sonst über den anderen Kategorien

URLs ohne `http(s)://` (z. B. `github.com`) werden automatisch mit `https://` ergänzt.

**Icons:** Der Server holt das Icon jeder gebookmarkten Seite selbst (`<link rel="icon">` der Startseite, sonst `/favicon.ico`, nur notfalls DuckDuckGo) und legt es in `favicons/` im Datenordner ab. Gefundene Icons werden monatlich erneuert, fehlende wöchentlich neu versucht. Der Browser fragt also keine fremden Dienste mehr, auch interne Seiten bekommen ihr echtes Icon, und offline sind die Icons da.

**Backups:** Vor jeder Änderung (auch vor Import und Zurücksetzen) landet der bisherige Stand in `backups/bookmarks-<Zeitstempel>.json`. Die letzten 100 bleiben erhalten. Wiederherstellen: die gewünschte Datei auf dem Server als `bookmarks.json` zurückkopieren, oder herunterladen und über „JSON importieren“ laden.

**Mehrere Geräte:** Speichert ein Gerät, während auf einem anderen noch der alte Stand offen ist, lehnt der Server das Speichern des alten Stands ab (HTTP 409). Die Seite meldet das und lädt den aktuellen Stand neu, statt die Änderung des anderen Geräts zu überschreiben. Beim Zurückwechseln in den Tab lädt die Seite ohnehin neu.

## Offline

Ohne Verbindung zum Server zeigt die Seite den zuletzt geladenen Stand samt Icons, unten links steht klein „Offline“, bei einer Fehlerseite mit HTTP-Status (z. B. „Offline · 525“, unterwegs ohne VPN). Stand und Grund stehen im Tooltip. Bearbeiten ist dann gesperrt. Sobald der Server wieder erreichbar ist, lädt die Seite selbst neu, ein Klick auf den Hinweis versucht es sofort.

- Ein Service Worker (`src/sw.js`) hält eine Kopie der Seite vor: zuerst Netz, nach 3 s oder bei einer Antwort, die nicht von diesem Server kommt (z. B. eine Fehlerseite von Cloudflare oder dem Reverse Proxy), die Kopie. Die Icons speichert er ebenfalls. Den letzten Datenstand merkt sich die Seite selbst im `localStorage`.
- Service Worker laufen nur über **HTTPS** (oder `localhost`). Über `http://<IP>:8080` funktioniert die Seite normal, aber ohne Offline-Modus.
- Im Reverse Proxy darf die Seite **nicht zwischengespeichert** werden (bei Nginx Proxy Manager: „Cache Assets“ aus).
- iPhone: die Seite als Web-App auf den Home-Bildschirm legen. In einem normalen Safari-Tab löscht iOS den Offline-Stand, wenn die Seite 7 Tage nicht genutzt wurde.
- Notschalter: Wie man den Service Worker wieder loswird, steht oben in `src/sw.js`.

## API

Wenn du programmatisch zugreifen willst:

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/bookmarks` | aktueller Stand als JSON (mit `_meta`) |
| `POST` | `/api/bookmarks` | Save (von der UI bei jeder Änderung). `_meta.updatedAt` muss dem gespeicherten Stand entsprechen, sonst `409` |
| `POST` | `/api/bookmarks/import` | komplettes Dokument ersetzen, ohne Konfliktprüfung |
| `GET` | `/api/bookmarks/export` | Download mit Datums-Dateinamen |
| `GET` | `/favicon?url=<Origin>` | Icon einer gebookmarkten Seite (selbst geholt und gespeichert), sonst `404` |
| `GET` | `/logo` | aktuelles Logo (User-Overlay vor Default) |
| `POST` | `/api/logo` | Logo-Upload (`Content-Type: image/{png,svg+xml,webp,jpeg}`, raw body) |
| `DELETE` | `/api/logo` | User-Logo-Overlay entfernen |

Alle Antworten tragen den Header `X-Bookmarks-App: 1`. Daran erkennen Seite und Service Worker, dass eine Antwort wirklich von diesem Server kommt.

## JSON-Format

```json
{
  "categories": [
    { "name": "...", "collapsed": false, "sidebar": false, "links": [{ "name": "...", "url": "..." }] }
  ],
  "tools": [],
  "bookmarks": [{ "name": "...", "url": "..." }]
}
```

- `categories` — alle Bookmark-Gruppen. `collapsed: true` rendert die Kategorie auf der Startseite als klickbares Tile (öffnet ein Modal mit der Liste); `false` (Default) zeigt sie inline mit allen Bookmarks direkt drunter. `sidebar: true` stellt sie in die Seitenleiste unter dem Logo. Beides wird im Edit-Dialog per Häkchen umgeschaltet.
- `tools` — Altlast aus einer früheren Version, bleibt leer. Einträge darin werden beim Laden in `categories` übernommen.
- `bookmarks` — flache Liste, sichtbar im `+`-Modal unter dem Bookmarks-Tab.

## Deployment als systemd-Service

Code nach `/opt/bookmarks` (gehört root), Daten nach `/var/lib/bookmarks` (legt systemd an), der Dienst läuft als eigener Benutzer ohne Root-Rechte. Node.js aus der Distribution oder dem NodeSource-Repo, aktuelle LTS.

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin bookmarks
sudo git clone https://github.com/xipiet/bookmarks.git /opt/bookmarks
cd /opt/bookmarks && sudo npm ci --omit=dev
```

```ini
[Unit]
Description=Bookmarks
After=network.target

[Service]
Type=simple
User=bookmarks
Group=bookmarks
WorkingDirectory=/opt/bookmarks
Environment=NODE_ENV=production
Environment=DATA_DIR=/var/lib/bookmarks
StateDirectory=bookmarks
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bookmarks
```

Update: `cd /opt/bookmarks && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart bookmarks`

> **Sicherheitshinweis:** Die API hat **keine Authentifizierung**. Wer den Port erreicht, kann lesen und schreiben. Stelle den Server nur lokal bzw. hinter einen Reverse-Proxy mit Auth und niemals direkt ins offene Internet. Für den Offline-Modus braucht es HTTPS, also einen Reverse Proxy mit Zertifikat.


## Lizenz

MIT — siehe [LICENSE](LICENSE).
