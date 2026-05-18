# Bookmarks

Eine sehr schlanke selbst gehostete Bookmark-Startseite. <br>
Daten und Logo werden komplett über die Web-UI verwaltet. Du kannst deinen Bestand jederzeit als JSON exportieren und auf einer anderen Instanz wieder importieren. <br>

https://github.com/user-attachments/assets/60860c24-1304-4fce-b14f-ab6e38e6b574

## Quick Start

```bash
npm install
npm start
```

UI: `http://localhost:8080`. Beim ersten Aufruf ohne `bookmarks.json` siehst du einen Empty-State:

- **JSON hochladen**: eine eigene Bookmark-Datei importieren
- **Beispiel laden**: mit `bookmarks.example.json` starten

Anschließend kannst du in der UI Kategorien und Bookmarks anlegen, bearbeiten und per Drag-and-Drop sortieren. Jede Änderung wird automatisch in `bookmarks.json` gespeichert.

## Daten und Logo verwalten

Über das `+`-Symbol unten rechts öffnest du das Fenster für "weitere Bookmarks" und die Möglichkeiten Einstellungen vorzunehmen. Dort findest du:

- **JSON importieren / exportieren / zurücksetzen** — Vor jedem Import einer neuen JSON wird die alte Datei nach `bookmarks.backup.json` gesichert
- **Logo ändern** — Hier kannst Du ein eigenes Logo hochladen und verwenden. Mit „Standard wiederherstellen" fällt die Anzeige auf das committete `logo.png` zurück. Das aktuelle Logo wird gleichzeitig als Favicon im Browser-Tab verwendet.
- **Erweiterte Verwaltung** — Kategorien, Tools und lose Bookmarks im Detail. Im Toggle „Bereiche eingeklappt anzeigen" stellst du ein, ob die drei Bereiche sofort aufgeklappt sind oder erst per Klick.

## API

Wenn du programmatisch zugreifen willst:

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/bookmarks` | aktueller Stand als JSON (mit `_meta`) |
| `POST` | `/api/bookmarks` | Save (von der UI bei jeder Änderung) |
| `POST` | `/api/bookmarks/import` | komplettes Dokument ersetzen, Backup wird angelegt |
| `GET` | `/api/bookmarks/export` | Download mit Datums-Dateinamen |
| `GET` | `/logo` | aktuelles Logo (User-Overlay vor Default) |
| `POST` | `/api/logo` | Logo-Upload (`Content-Type: image/{png,svg+xml,webp,jpeg}`, raw body) |
| `DELETE` | `/api/logo` | User-Logo-Overlay entfernen |

## JSON-Format

```json
{
  "categories": [
    { "name": "...", "collapsed": false, "links": [{ "name": "...", "url": "..." }] }
  ],
  "tools": [],
  "bookmarks": [{ "name": "...", "url": "..." }]
}
```

- `categories` — alle Bookmark-Gruppen. `collapsed: true` rendert die Kategorie auf der Startseite als klickbares Tile (öffnet ein Modal mit der Liste); `false` (Default) zeigt sie inline mit allen Bookmarks direkt drunter. Wird im Edit-Dialog per Häkchen umgeschaltet.
- `bookmarks` — flache Liste, sichtbar im `+`-Modal unter dem Bookmarks-Tab.

## Deployment als systemd-Service

```ini
[Unit]
Description=Bookmarks Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/bookmarks
Environment=PATH=/root/.nvm/versions/node/v24.13.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/root/.nvm/versions/node/v24.13.0/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bookmarks
```

> **Sicherheitshinweis:** Die API hat **keine Authentifizierung**. Wer den Port erreicht, kann lesen und schreiben. Stelle den Server nur lokal bzw. hinter einen Reverse-Proxy mit Auth und niemals direkt ins offene Internet.


## Lizenz

MIT — siehe [LICENSE](LICENSE).
