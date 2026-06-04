const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 8080;

const ROOT = __dirname;
const bookmarksFile = path.join(ROOT, 'bookmarks.json');
const backupFile = path.join(ROOT, 'bookmarks.backup.json');

const EMPTY_DOC = { categories: [], tools: [], bookmarks: [] };

app.use(bodyParser.json({ limit: '5mb' }));
app.use(express.static(ROOT));

// Serve the main page with CSS, JS and logo inlined, so a browser "Save Page
// As" yields a single self-contained .html that still renders offline (file://)
// regardless of the chosen save mode. The source files stay separate on disk
// (the dev workflow is unaffected) — they are only stitched together here, read
// fresh on every request so edits are still picked up on refresh.
app.get('/', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');

    // Inline the stylesheet. Escaping </style guards against a breakout.
    html = html.replace(
      '<link rel="stylesheet" href="/src/styles.css">',
      '<style>\n' + css.replace(/<\/style/gi, '<\\/style') + '\n</style>'
    );

    // Inline the script. Must stay a CLASSIC script (not a module) so the
    // global onclick="..." handlers keep resolving. Escaping </script guards
    // against a breakout.
    html = html.replace(
      '<script src="/src/app.js"></script>',
      '<script>\n' + js.replace(/<\/script/gi, '<\\/script') + '\n</script>'
    );

    // Inline the logo as a data URI for both the favicon and the header image,
    // so the saved copy needs no external logo file. Precise tag strings keep
    // app.js's own "/logo" reference (settings preview) untouched.
    const logo = logoDataUri();
    if (logo) {
      html = html.replace('<link rel="icon" href="/logo">', '<link rel="icon" href="' + logo + '">');
      html = html.replace(
        '<img src="/logo" alt="Logo" class="logo" id="pageLogo">',
        '<img src="' + logo + '" alt="Logo" class="logo" id="pageLogo">'
      );
    }

    res.type('html').send(html);
  } catch (error) {
    console.error('Error rendering index:', error);
    res.status(500).send('Failed to render page');
  }
});

// Logo route: prefers a user-uploaded logo.user.* (overlay, gitignored)
// over the committed default logo.png. Used by both <img> and <link rel="icon">.
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

// Resolve the active logo (user overlay first, then committed default) to a
// base64 data: URI for inlining into the served page. Null if none exists.
function logoDataUri() {
  for (const [name, mime] of [...LOGO_USER_CANDIDATES, ...LOGO_DEFAULTS]) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) {
      return 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
    }
  }
  return null;
}

app.get('/logo', (req, res) => {
  for (const [name, mime] of [...LOGO_USER_CANDIDATES, ...LOGO_DEFAULTS]) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) {
      res.set('Cache-Control', 'no-cache');
      res.type(mime);
      return res.sendFile(p);
    }
  }
  res.status(404).send('No logo');
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
        const p = path.join(ROOT, name);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      fs.writeFileSync(path.join(ROOT, 'logo.user.' + ext), req.body);
      res.json({ success: true, ext });
    } catch (error) {
      console.error('Error saving logo:', error);
      res.status(500).json({ error: 'Failed to save logo: ' + error.message });
    }
  }
);

// Reset the user logo overlay — falls back to the committed default.
app.delete('/api/logo', (req, res) => {
  let removed = 0;
  for (const [name] of LOGO_USER_CANDIDATES) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; }
  }
  res.json({ success: true, removed });
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

function writeDoc(doc) {
  fs.writeFileSync(bookmarksFile, JSON.stringify(doc, null, 2), 'utf8');
}

app.get('/api/bookmarks', (req, res) => {
  try {
    res.json(readDoc());
  } catch (error) {
    console.error('Error reading bookmarks:', error);
    res.status(500).json({ error: 'Failed to read bookmarks: ' + error.message });
  }
});

// Save (mutation from the running UI). Preserves _meta from the previous file
// unless the client explicitly sends a new one.
app.post('/api/bookmarks', (req, res) => {
  try {
    const err = validateDoc(req.body);
    if (err) return res.status(400).json({ error: err });

    let prevMeta = {};
    if (fs.existsSync(bookmarksFile)) {
      try { prevMeta = (JSON.parse(fs.readFileSync(bookmarksFile, 'utf8'))._meta) || {}; } catch {}
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

// Import a full document from an uploaded JSON file. Stricter validation,
// backs up the previous file before overwriting.
app.post('/api/bookmarks/import', (req, res) => {
  try {
    const err = validateDoc(req.body);
    if (err) return res.status(400).json({ error: err });

    if (fs.existsSync(bookmarksFile)) {
      fs.copyFileSync(bookmarksFile, backupFile);
    }

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
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="bookmarks-${today}.json"`);
  fs.createReadStream(bookmarksFile).pipe(res);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bookmarks server running at http://0.0.0.0:${PORT}`);
});
