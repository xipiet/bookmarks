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

Läuft auf `http://localhost:8080`. Port und Datenordner änderst du mit `PORT` und `DATA_DIR`.

## Als Dienst (systemd)

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin bookmarks
sudo git clone https://github.com/xipiet/bookmarks.git /opt/bookmarks
cd /opt/bookmarks && sudo npm ci --omit=dev
```

`/etc/systemd/system/bookmarks.service`:

```ini
[Unit]
Description=Bookmarks
After=network.target

[Service]
User=bookmarks
WorkingDirectory=/opt/bookmarks
Environment=NODE_ENV=production DATA_DIR=/var/lib/bookmarks
StateDirectory=bookmarks
ExecStart=/usr/bin/node server.js
Restart=always
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bookmarks
```

**Update:** `cd /opt/bookmarks && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart bookmarks`

## Wichtig

- Es gibt keine Anmeldung: Wer die Seite erreicht, kann alles ändern. Nur im LAN/VPN oder hinter einem Reverse Proxy mit Login betreiben.
- Der Offline-Modus (ohne Verbindung den letzten Stand anzeigen) funktioniert nur über HTTPS.

## Lizenz

MIT — siehe [LICENSE](LICENSE).
