const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const ROOT = __dirname;
// Per-instance data (bookmarks.json, backups/, uploaded logo). Defaults to the
// app directory for `npm start`; a deployment points it elsewhere so that a
// redeploy or `git clean` can never touch the data.
const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT);
const bookmarksFile = path.join(DATA_DIR, 'bookmarks.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 100;

const EMPTY_DOC = { categories: [], tools: [], bookmarks: [] };

app.disable('x-powered-by');
// Marks every response as coming from this app. The service worker and the
// client use it to tell a real answer from a proxy or Cloudflare error page.
app.use((req, res, next) => {
  res.set('X-Bookmarks-App', '1');
  next();
});
app.use(express.json({ limit: '5mb' }));
// Only the frontend sources are public, never the app directory itself
// (data files, server code, .git, node_modules).
app.use('/src', express.static(path.join(ROOT, 'src')));
app.get('/bookmarks.example.json', (req, res) => {
  res.sendFile(path.join(ROOT, 'bookmarks.example.json'));
});

// Service worker (offline copy of the page, see src/sw.js). Served from the
// root so its scope covers "/", and never cached so changes arrive right away.
app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(ROOT, 'src', 'sw.js'), {
    cacheControl: false,
    headers: { 'Cache-Control': 'no-cache' },
  });
});

// Serve the main page with CSS, JS and logo inlined, so the whole app is one
// self-contained response: the service worker caches exactly this as the
// offline copy, which can never mix files from different versions. The source
// files stay separate on disk (the dev workflow is unaffected) — they are only
// stitched together here, read fresh on every request so edits are still
// picked up on refresh.
app.get('/', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');

    // The replacements are passed as functions: a plain replacement string
    // would interpret "$&", "$'" etc. inside the CSS/JS and silently mangle it.

    // Inline the stylesheet. Escaping </style guards against a breakout.
    html = html.replace(
      '<link rel="stylesheet" href="/src/styles.css">',
      () => '<style>\n' + css.replace(/<\/style/gi, '<\\/style') + '\n</style>'
    );

    // Inline the script. Must stay a CLASSIC script (not a module) so the
    // global onclick="..." handlers keep resolving. Escaping </script guards
    // against a breakout.
    html = html.replace(
      '<script src="/src/app.js"></script>',
      () => '<script>\n' + js.replace(/<\/script/gi, '<\\/script') + '\n</script>'
    );

    // Inline the logo as a data URI for both the favicon and the header image,
    // so the saved copy needs no external logo file. Precise tag strings keep
    // app.js's own "/logo" reference (settings preview) untouched.
    const logo = logoDataUri();
    if (logo) {
      html = html.replace('<link rel="icon" href="/logo">', () => '<link rel="icon" href="' + logo + '">');
      html = html.replace(
        '<img src="/logo" alt="Logo" class="logo" id="pageLogo">',
        () => '<img src="' + logo + '" alt="Logo" class="logo" id="pageLogo">'
      );
    }

    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (error) {
    console.error('Error rendering index:', error);
    res.status(500).send('Failed to render page');
  }
});

// Logo route: prefers a user-uploaded logo.user.* (overlay in DATA_DIR,
// gitignored) over the committed default logo.png. Used by both <img> and
// <link rel="icon">.
const LOGO_USER_CANDIDATES = [
  ['logo.user.png', 'image/png'],
  ['logo.user.svg', 'image/svg+xml'],
  ['logo.user.webp', 'image/webp'],
  ['logo.user.jpg', 'image/jpeg'],
  ['logo.user.jpeg', 'image/jpeg'],
];
const LOGO_DEFAULTS = [
  ['logo.png', 'image/png'],
  ['logo.svg', 'image/svg+xml'],
];

// The active logo as [absolute path, mime], or null if none exists.
function activeLogo() {
  const candidates = [
    ...LOGO_USER_CANDIDATES.map(([name, mime]) => [path.join(DATA_DIR, name), mime]),
    ...LOGO_DEFAULTS.map(([name, mime]) => [path.join(ROOT, name), mime]),
  ];
  return candidates.find(([p]) => fs.existsSync(p)) || null;
}

// The active logo as a base64 data: URI for inlining into the served page.
function logoDataUri() {
  const logo = activeLogo();
  if (!logo) return null;
  return 'data:' + logo[1] + ';base64,' + fs.readFileSync(logo[0]).toString('base64');
}

app.get('/logo', (req, res) => {
  const logo = activeLogo();
  if (!logo) return res.status(404).send('No logo');
  res.set('Cache-Control', 'no-cache');
  res.type(logo[1]);
  res.sendFile(logo[0]);
});

// Logo upload: writes the raw request body as logo.user.<ext>. Used by the
// "Logo ändern"-Button in the UI. Clears any previous user logo to avoid
// stale variants sitting on disk.
const MIME_TO_EXT = {
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
};
app.post(
  '/api/logo',
  express.raw({ type: Object.keys(MIME_TO_EXT), limit: '10mb' }),
  (req, res) => {
    try {
      const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = MIME_TO_EXT[mime];
      if (!ext) return res.status(400).json({ error: 'Unsupported image type: ' + mime });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty body' });
      }
      // Remove all previously uploaded user logos (one per extension).
      for (const [name] of LOGO_USER_CANDIDATES) {
        const p = path.join(DATA_DIR, name);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      fs.writeFileSync(path.join(DATA_DIR, 'logo.user.' + ext), req.body);
      res.json({ success: true, ext });
    } catch (error) {
      console.error('Error saving logo:', error);
      res.status(500).json({ error: 'Failed to save logo: ' + error.message });
    }
  }
);

// Reset the user logo overlay — falls back to the committed default.
app.delete('/api/logo', (req, res) => {
  try {
    let removed = 0;
    for (const [name] of LOGO_USER_CANDIDATES) {
      const p = path.join(DATA_DIR, name);
      if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; }
    }
    res.json({ success: true, removed });
  } catch (error) {
    console.error('Error removing logo:', error);
    res.status(500).json({ error: 'Failed to remove logo: ' + error.message });
  }
});

function readDoc() {
  if (!fs.existsSync(bookmarksFile)) {
    return { ...EMPTY_DOC, _meta: { empty: true } };
  }
  const raw = fs.readFileSync(bookmarksFile, 'utf8');
  const parsed = JSON.parse(raw);
  // Backfill missing top-level arrays so the client can assume their presence.
  return {
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    tools: Array.isArray(parsed.tools) ? parsed.tools : [],
    bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
    _meta: parsed._meta || {},
  };
}

function validateDoc(body) {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object';
  const { categories, tools, bookmarks } = body;
  if (!Array.isArray(categories) || !Array.isArray(tools) || !Array.isArray(bookmarks)) {
    return 'categories, tools, and bookmarks must all be arrays';
  }
  const isLink = (l) => l && typeof l.name === 'string' && typeof l.url === 'string';
  const isGroup = (g) => g && typeof g.name === 'string' && Array.isArray(g.links) && g.links.every(isLink);
  if (!categories.every(isGroup)) return 'Each category must have {name: string, links: [{name, url}]}';
  if (!tools.every(isGroup)) return 'Each tool group must have {name: string, links: [{name, url}]}';
  if (!bookmarks.every(isLink)) return 'Each bookmark must have {name: string, url: string}';
  return null;
}

// Copy the current file into backups/ before it gets replaced, keeping the
// newest BACKUP_KEEP. A file that doesn't parse is skipped so a broken
// bookmarks.json can never rotate the good backups away.
function backupCurrent() {
  if (!fs.existsSync(bookmarksFile)) return;
  const raw = fs.readFileSync(bookmarksFile, 'utf8');
  try { JSON.parse(raw); } catch { return; }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(BACKUP_DIR, 'bookmarks-' + stamp + '.json'), raw);
  const all = fs.readdirSync(BACKUP_DIR).filter((f) => /^bookmarks-.+\.json$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
}

// Atomic replace: write a temp file, flush it to disk, then rename over the
// original. A crash or full disk mid-write leaves the old file intact instead
// of a truncated one.
function writeDoc(doc) {
  backupCurrent();
  const tmp = bookmarksFile + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(doc, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, bookmarksFile);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

app.get('/api/bookmarks', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(readDoc());
  } catch (error) {
    console.error('Error reading bookmarks:', error);
    res.status(500).json({ error: 'Failed to read bookmarks: ' + error.message });
  }
});

// Save (mutation from the running UI). Preserves _meta from the previous file
// unless the client explicitly sends a new one.
//
// Conflict check: the client sends back the _meta.updatedAt it last loaded.
// If the file has moved on since (another device or tab saved in between),
// the save is refused with 409 instead of silently overwriting that change.
app.post('/api/bookmarks', (req, res) => {
  try {
    const err = validateDoc(req.body);
    if (err) return res.status(400).json({ error: err });

    let prevMeta = {};
    if (fs.existsSync(bookmarksFile)) {
      try { prevMeta = (JSON.parse(fs.readFileSync(bookmarksFile, 'utf8'))._meta) || {}; } catch {}
    }
    const base = req.body._meta && req.body._meta.updatedAt;
    if (prevMeta.updatedAt && base !== prevMeta.updatedAt) {
      return res.status(409).json({ error: 'Inzwischen woanders geändert', conflict: true });
    }
    const _meta = {
      ...prevMeta,
      ...(req.body._meta || {}),
      updatedAt: new Date().toISOString(),
    };
    delete _meta.empty;

    writeDoc({
      _meta,
      categories: req.body.categories,
      tools: req.body.tools,
      bookmarks: req.body.bookmarks,
    });
    res.json({ success: true, _meta });
  } catch (error) {
    console.error('Error saving bookmarks:', error);
    res.status(500).json({ error: 'Failed to save bookmarks' });
  }
});

// Import a full document from an uploaded JSON file. Replaces everything on
// purpose, so there is no conflict check; writeDoc backs up the old file.
app.post('/api/bookmarks/import', (req, res) => {
  try {
    const err = validateDoc(req.body);
    if (err) return res.status(400).json({ error: err });

    const _meta = {
      filename: (req.body._meta && typeof req.body._meta.filename === 'string')
        ? req.body._meta.filename
        : 'bookmarks.json',
      importedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    writeDoc({
      _meta,
      categories: req.body.categories,
      tools: req.body.tools,
      bookmarks: req.body.bookmarks,
    });
    res.json({ success: true, _meta });
  } catch (error) {
    console.error('Error importing bookmarks:', error);
    res.status(500).json({ error: 'Failed to import bookmarks: ' + error.message });
  }
});

app.get('/api/bookmarks/export', (req, res) => {
  if (!fs.existsSync(bookmarksFile)) {
    return res.status(404).json({ error: 'No bookmarks to export' });
  }
  const today = new Date().toISOString().slice(0, 10);
  res.download(bookmarksFile, `bookmarks-${today}.json`, (error) => {
    if (!error) return;
    console.error('Error exporting bookmarks:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to export bookmarks' });
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Bookmarks server running at http://${HOST}:${PORT} (data: ${DATA_DIR})`);
});
