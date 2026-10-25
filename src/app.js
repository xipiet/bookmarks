let allData = { categories: [], tools: [], bookmarks: [], _meta: {} };

// True only while allData mirrors what the server last confirmed. Before the
// first successful load (or after a failed one) nothing may be saved, or the
// near-empty default above would overwrite the real file.
let editable = false;

// --- safety helpers ---------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

function safeHref(url) {
    const s = String(url || '').trim();
    if (/^https?:\/\//i.test(s) || s.startsWith('/') || s.startsWith('#')) return escapeHtml(s);
    return '#';
}

function getDomainFromUrl(url) {
    try { return new URL(url).hostname; } catch { return null; }
}

function faviconImg(url) {
    const domain = getDomainFromUrl(url);
    // Plain hostnames only. The domain ends up inside a JS string in the
    // onerror attribute, where the HTML parser undoes escapeHtml — a host like
    // x'-alert(1)-' (valid for the URL parser) would otherwise run as code.
    if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) return '';
    return '<img src="https://icons.duckduckgo.com/ip3/' + domain + '.ico" alt="" class="favicon" ' +
           'onerror="this.onerror=null;this.src=\'https://www.google.com/s2/favicons?domain=' + domain + '&sz=32\'"/>';
}

// A category is "collapsed" if it renders as a clickable tile that opens a
// modal (instead of showing its bookmarks inline). Per-entry flag; missing
// defaults to expanded.
function isCollapsed(entry) {
    return !!(entry && entry.collapsed);
}

// A category with `sidebar: true` renders in the column under the logo
// instead of the main grid. Missing defaults to the grid.
function isSidebar(entry) {
    return !!(entry && entry.sidebar);
}

// --- data layer -------------------------------------------------------------

const SNAPSHOT_KEY = 'bookmarks.snapshot';
const LOAD_TIMEOUT_MS = 4000;
const SAVE_TIMEOUT_MS = 10000;
const RETRY_DELAYS_MS = [3000, 10000, 30000, 60000];

function normalizeData() {
    if (!allData._meta) allData._meta = {};
    if (!Array.isArray(allData.tools)) allData.tools = [];
    if (!Array.isArray(allData.categories)) allData.categories = [];
    if (!Array.isArray(allData.bookmarks)) allData.bookmarks = [];
}

// fetch() with a time limit: with a half-connected VPN a request can hang for
// minutes. Network errors and timeouts become readable German messages.
async function fetchWithTimeout(url, options, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        throw new Error(error.name === 'AbortError' ? 'Zeitüberschreitung' : 'Keine Verbindung');
    } finally {
        clearTimeout(timer);
    }
}

// Only a 2xx that carries the app's marker header counts as an answer from
// this server. Outside the LAN without VPN the name resolves to Cloudflare,
// which replies with its own error page (HTTP 525), not a network error.
async function fetchDoc() {
    const response = await fetchWithTimeout('/api/bookmarks', { cache: 'no-store' }, LOAD_TIMEOUT_MS);
    if (!response.ok) {
        const hint = response.status >= 520 && response.status < 530 ? ', VPN aus?' : '';
        throw new Error('Server nicht erreichbar (HTTP ' + response.status + hint + ')');
    }
    if (response.headers.get('X-Bookmarks-App') !== '1') {
        throw new Error('Unerwartete Antwort, nicht vom Bookmarks-Server');
    }
    return response.json();
}

// The last state the server confirmed, kept in localStorage so the page can
// still show it while the server is out of reach. Never sent back to the
// server: offline the page is read-only.
function storeSnapshot() {
    try {
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ at: new Date().toISOString(), doc: allData }));
    } catch (e) {
        console.warn('Offline-Stand nicht gespeichert:', e);
    }
}

function readSnapshot() {
    try {
        const snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY));
        return snap && snap.doc ? snap : null;
    } catch {
        return null;
    }
}

// One load at a time: the retry timer, the online event and the retry button
// can fire together.
let loadPromise = null;
function loadData() {
    if (!loadPromise) loadPromise = loadFromServer().finally(() => { loadPromise = null; });
    return loadPromise;
}

async function loadFromServer() {
    let doc;
    try {
        doc = await fetchDoc();
    } catch (error) {
        console.error('Error loading bookmarks:', error);
        showOffline(error.message);
        return;
    }
    allData = doc;
    normalizeData();
    setOnline();
    storeSnapshot();

    // Legacy migration: the old schema had a separate `tools` array for
    // categories that should render as clickable tiles. The `collapsed`
    // flag on each category covers that use case now, so fold any leftover
    // tools entries into `categories` (defaulting to collapsed=true to
    // preserve their previous visual behavior) and persist once.
    if (allData.tools.length > 0) {
        const migrated = allData.tools.map(t => ({
            name: t.name,
            collapsed: typeof t.collapsed === 'boolean' ? t.collapsed : true,
            links: Array.isArray(t.links) ? t.links : [],
        }));
        allData.categories = [...allData.categories, ...migrated];
        allData.tools = [];
        renderAll();
        // Not awaited: loadData also runs as the reload inside a failed
        // save, and waiting there for the save queue would deadlock. If it
        // doesn't persist now, the next load simply migrates again.
        saveData();
        return;
    }

    renderAll();
}

// --- offline mode -----------------------------------------------------------

let retryTimer = null;
let retryCount = 0;

// Server out of reach: show the last confirmed state read-only (or an error if
// this device has none yet) and keep retrying in the background.
function showOffline(reason) {
    editable = false;
    const snap = readSnapshot();
    if (snap) {
        allData = snap.doc;
        normalizeData();
        renderAll();
    } else {
        renderError('Konnte Bookmarks nicht laden: ' + reason);
    }
    renderBanner(snap && snap.at, reason);
    scheduleRetry();
}

function setOnline() {
    editable = true;
    retryCount = 0;
    clearTimeout(retryTimer);
    renderBanner();
}

function scheduleRetry() {
    clearTimeout(retryTimer);
    const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
    retryCount++;
    // In a background tab nothing happens; the visibilitychange handler
    // retries as soon as the tab is shown again.
    retryTimer = setTimeout(() => {
        if (document.visibilityState === 'visible') loadData();
    }, delay);
}

function renderBanner(snapshotAt, reason) {
    const banner = document.getElementById('offlineBanner');
    if (editable) {
        banner.hidden = true;
        return;
    }
    const when = snapshotAt
        ? new Date(snapshotAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
        : null;
    banner.innerHTML = '<span><strong>Offline</strong>'
        + (when ? ' · Stand vom ' + escapeHtml(when) + ' · nur lesen' : '') + '</span>'
        + '<span class="offline-reason">' + escapeHtml(reason) + '</span>'
        + '<button type="button" class="btn btn-sm" id="retryBtn">Erneut versuchen</button>';
    document.getElementById('retryBtn').onclick = () => loadData();
    banner.hidden = false;
}

// Back online or back on the tab: retry while offline, otherwise reload so
// changes from other devices show up. Never while a save runs or a dialog is
// open while editable — the dialogs hold indices into allData.
function refreshFromServer() {
    if (document.visibilityState !== 'visible') return;
    if (editable && (savePromise || document.querySelector('.modal.active'))) return;
    loadData();
}

// --- saving -----------------------------------------------------------------

let savePromise = null;
let saveAgain = false;

async function saveData() {
    if (!requireEditable()) return false;
    // One request at a time: a change made while a save is in flight is sent
    // afterwards (with the then-current state), so an older request can never
    // land after a newer one. Callers get a promise that resolves once their
    // change is on disk (true) or was discarded (false).
    if (savePromise) {
        saveAgain = true;
        return savePromise;
    }
    savePromise = (async () => {
        let ok;
        do {
            saveAgain = false;
            ok = await postData();
        } while (ok && saveAgain);
        return ok;
    })();
    try {
        return await savePromise;
    } finally {
        savePromise = null;
    }
}

// Sends allData once. The server rejects it with 409 if the file changed since
// we loaded it (_meta.updatedAt). On any failure the unsaved local change is
// thrown away by reloading the server state, so the UI never drifts away from
// what is actually stored.
async function postData() {
    try {
        const response = await fetchWithTimeout('/api/bookmarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(allData),
        }, SAVE_TIMEOUT_MS);
        if (response.status === 409) {
            alert('Die Bookmarks wurden inzwischen auf einem anderen Gerät oder in einem anderen Tab geändert. '
                + 'Deine letzte Änderung wurde nicht gespeichert, der aktuelle Stand wird geladen.');
            await loadData();
            return false;
        }
        const result = await readJson(response);
        if (result._meta) allData._meta = result._meta;
        storeSnapshot();
        renderAll();
        return true;
    } catch (error) {
        console.error('Error saving bookmarks:', error);
        alert('Speichern fehlgeschlagen: ' + error.message + '\nDer zuletzt gespeicherte Stand wird wieder geladen.');
        await loadData();
        return false;
    }
}

// Parses a JSON API response; non-2xx (incl. HTML error pages from a proxy)
// becomes an Error with a readable message instead of a JSON SyntaxError.
async function readJson(response) {
    if (!response.ok) {
        let msg = 'HTTP ' + response.status;
        try { const body = await response.json(); if (body && body.error) msg = body.error; } catch {}
        throw new Error(msg);
    }
    return response.json();
}

// Guard for every write path. Returns false (and tells the user) while the
// data on screen is not a confirmed server state.
function requireEditable() {
    if (editable) return true;
    alert('Bearbeiten ist gerade nicht möglich, weil keine Verbindung zum Server besteht.');
    return false;
}

async function importDoc(doc, filename) {
    const body = {
        categories: doc.categories || [],
        tools: doc.tools || [],
        bookmarks: doc.bookmarks || [],
        _meta: { filename: filename || (doc._meta && doc._meta.filename) || 'bookmarks.json' },
    };
    const response = await fetch('/api/bookmarks/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return readJson(response);
}

// --- rendering --------------------------------------------------------------

function renderAll() {
    renderContent();
    renderAllBookmarks();
    if (isSettingsTabActive()) renderSettingsTab();
}

function renderError(msg) {
    const content = document.getElementById('content');
    document.getElementById('emptyState').hidden = true;
    document.getElementById('sidebar').hidden = true;
    content.hidden = false;
    content.innerHTML = '<div class="no-results">' + escapeHtml(msg) + '</div>';
}

function isContentEmpty() {
    return (allData.categories || []).length === 0
        && (allData.bookmarks || []).length === 0;
}

function renderContent() {
    const content = document.getElementById('content');
    const sidebar = document.getElementById('sidebar');
    const emptyState = document.getElementById('emptyState');
    content.innerHTML = '';
    sidebar.innerHTML = '';

    if (isContentEmpty()) {
        emptyState.hidden = false;
        content.hidden = true;
        sidebar.hidden = true;
        return;
    }
    emptyState.hidden = true;
    content.hidden = false;

    (allData.categories || []).forEach(entry => {
        (isSidebar(entry) ? sidebar : content).appendChild(renderCategoryBlock(entry));
    });
    sidebar.hidden = !sidebar.hasChildNodes();
}

function renderCategoryBlock(entry) {
    const div = document.createElement('div');
    if (isCollapsed(entry)) {
        div.className = 'tool-category';
        div.innerHTML = '<h2>' + escapeHtml(entry.name) + '</h2>';
        div.onclick = () => openCategoryModal(entry);
    } else {
        div.className = 'category';
        const items = (entry.links || []).map(link =>
            '<li><a href="' + safeHref(link.url) + '" target="_blank" rel="noopener">'
            + faviconImg(link.url) + '<span>' + escapeHtml(link.name) + '</span></a></li>'
        ).join('');
        div.innerHTML = '<h2>' + escapeHtml(entry.name) + '</h2><ul>' + items + '</ul>';
    }
    return div;
}

function openCategoryModal(entry) {
    document.getElementById('toolsModalTitle').textContent = entry.name;
    renderToolsList(entry);
    document.getElementById('toolsModal').classList.add('active');
    document.getElementById('toolsSearchInput').focus();
}

function renderAllBookmarks() {
    const bookmarkList = document.getElementById('bookmarkList');
    let html = '';
    if (allData.bookmarks && allData.bookmarks.length > 0) {
        allData.bookmarks.forEach(bookmark => {
            html += '<div class="bookmark-item"><a href="' + safeHref(bookmark.url) + '" target="_blank" rel="noopener">'
                  + faviconImg(bookmark.url)
                  + '<span class="name">' + escapeHtml(bookmark.name) + '</span></a></div>';
        });
    } else {
        html = '<div class="no-results">Keine losen Bookmarks</div>';
    }
    bookmarkList.innerHTML = html;
}

// --- tab management --------------------------------------------------------

function isSettingsTabActive() {
    const btn = document.querySelector('.tab-btn.active');
    return btn && btn.dataset.tab === 'settings';
}

function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(p => {
        p.hidden = p.dataset.panel !== tab;
    });
    if (tab === 'settings') {
        renderSettingsTab();
    }
}

// --- settings tab content ---------------------------------------------------

function renderSettingsTab() {
    const panel = document.getElementById('settingsPanel');

    if (!editable) {
        panel.innerHTML = '<div class="no-results">Offline: Bearbeiten ist erst wieder möglich, wenn der Server erreichbar ist.</div>';
        return;
    }

    const emptyCallout = isContentEmpty()
        ? '<div class="empty-callout"><span>Liste ist leer.</span>'
          + '<button type="button" class="status-action" id="settingsLoadExampleBtn">Beispiel laden</button>'
          + '</div>'
        : '';

    panel.innerHTML =
        '<div class="status-line" id="statusLine"></div>' +
        emptyCallout +

        '<div class="settings-group">' +
            '<h3>Datei</h3>' +
            '<div class="manage-actions">' +
                '<button type="button" class="btn btn-primary" id="manageImportBtn">JSON importieren</button>' +
                '<button type="button" class="btn" id="manageExportBtn">JSON exportieren</button>' +
                '<button type="button" class="btn btn-danger" id="manageResetBtn">Zurücksetzen</button>' +
            '</div>' +
        '</div>' +

        '<div class="settings-group">' +
            '<h3>Logo</h3>' +
            '<div class="logo-panel">' +
                '<img src="/logo" alt="Logo-Vorschau" class="logo-preview" id="logoPreview">' +
                '<div class="logo-actions">' +
                    '<div class="logo-label">Wird auch als Favicon verwendet</div>' +
                    '<div>' +
                        '<button type="button" class="btn" id="manageLogoBtn">Logo ändern</button>' +
                        '<button type="button" class="btn btn-sm" id="manageLogoResetBtn" hidden>Standard wiederherstellen</button>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>' +

        '<div class="settings-group">' +
            '<h3>Kategorien</h3>' +
            '<div id="categoriesList"></div>' +
            '<button class="btn" onclick="addCategory()" style="width:100%;margin-top:12px;">+ Kategorie hinzufügen</button>' +
        '</div>' +

        '<div class="settings-group">' +
            '<h3>Lose Bookmarks</h3>' +
            '<div id="generalBookmarksList"></div>' +
            '<button class="btn" onclick="addGeneralBookmark()" style="width:100%;margin-top:12px;">+ Bookmark hinzufügen</button>' +
        '</div>';

    document.getElementById('manageImportBtn').onclick = triggerImport;
    document.getElementById('manageExportBtn').onclick = triggerExport;
    document.getElementById('manageResetBtn').onclick = resetData;
    document.getElementById('manageLogoBtn').onclick = triggerLogoUpload;
    document.getElementById('manageLogoResetBtn').onclick = resetLogo;
    const exampleBtn = document.getElementById('settingsLoadExampleBtn');
    if (exampleBtn) exampleBtn.onclick = loadExample;

    renderStatusLine();
    renderCategories();
    renderGeneralBookmarks();
}

function renderStatusLine() {
    const el = document.getElementById('statusLine');
    if (!el) return;
    if (allData._meta && allData._meta.empty) {
        el.innerHTML = '<span>Keine Daten geladen — importiere eine JSON oder lade das Beispiel.</span>';
        return;
    }
    const filename = (allData._meta && allData._meta.filename) || 'bookmarks.json';
    const total = (allData.categories || []).reduce((n, c) => n + (c.links || []).length, 0)
        + (allData.bookmarks || []).length;
    const updated = allData._meta && allData._meta.updatedAt
        ? new Date(allData._meta.updatedAt).toLocaleString()
        : null;
    let html = 'Geladen: <span class="status-filename">' + escapeHtml(filename) + '</span>'
             + ' <span class="status-sep">·</span> ' + total + ' Einträge';
    if (updated) html += ' <span class="status-sep">·</span> aktualisiert ' + escapeHtml(updated);
    el.innerHTML = html;
}

// Per-session view state for the settings panel: which categories currently
// show their bookmark list. Keyed by the category *object* so the state
// survives re-renders (after a drag or edit) but resets on import/reload.
// Purely a view concern — never persisted to bookmarks.json.
const expandedInSettings = new WeakSet();

function toggleCategoryExpand(idx, btn) {
    const cat = allData.categories[idx];
    if (!cat) return;
    const section = btn.closest('.category-section');
    const expand = !expandedInSettings.has(cat);
    if (expand) expandedInSettings.add(cat);
    else expandedInSettings.delete(cat);
    if (section) section.classList.toggle('collapsed', !expand);
}

function renderCategories() {
    const list = document.getElementById('categoriesList');
    if (!list) return;
    let html = '';
    allData.categories.forEach((cat, catIdx) => {
        const mode = (isCollapsed(cat) ? 'eingeklappt' : 'ausgeklappt') + (isSidebar(cat) ? ' · Seitenleiste' : '');
        const expanded = expandedInSettings.has(cat);
        html += '<div class="category-section' + (expanded ? '' : ' collapsed') + '">'
              + '<div class="admin-item category-header" draggable="true" data-drag-type="category" data-category="' + catIdx + '">'
              + '<div class="drag-handle">⋮</div>'
              + '<button type="button" class="cat-toggle" onclick="toggleCategoryExpand(' + catIdx + ', this)" title="Bookmarks ein-/ausklappen"><span class="chev">▶</span></button>'
              + '<div class="admin-item-content"><div>'
              + '<div style="font-weight:600;">' + escapeHtml(cat.name) + '</div>'
              + '<div class="admin-item-meta">' + cat.links.length + ' Bookmarks · ' + mode + '</div>'
              + '</div></div><div class="admin-buttons">'
              + '<button class="btn btn-primary" onclick="editCategoryEntry(' + catIdx + ')">Bearbeiten</button>'
              + '<button class="btn btn-danger" onclick="deleteCategoryEntry(' + catIdx + ')">Löschen</button>'
              + '</div></div>';

        // Collapsible body (bookmark list + add button). The grid-rows wrapper
        // animates open/closed; see .category-body in styles.css.
        html += '<div class="category-body"><div class="category-body-inner">';
        if (cat.links && cat.links.length > 0) {
            html += '<div class="category-bookmarks" data-category="' + catIdx + '">';
            cat.links.forEach((link, linkIdx) => {
                html += '<div class="admin-item nested-item" draggable="true" data-drag-type="link" data-category="' + catIdx + '" data-index="' + linkIdx + '">'
                      + '<div class="drag-handle">⋮</div>'
                      + '<div class="admin-item-content"><div>'
                      + '<div style="font-weight:600;" title="' + escapeHtml(link.name) + '">' + escapeHtml(link.name) + '</div>'
                      + '<div class="admin-item-meta" title="' + escapeHtml(link.url) + '">' + escapeHtml(link.url) + '</div>'
                      + '</div></div><div class="admin-buttons">'
                      + '<button class="btn btn-primary btn-sm" onclick="editCategoryLink(' + catIdx + ', ' + linkIdx + ')">Bearbeiten</button>'
                      + '<button class="btn btn-danger btn-sm" onclick="deleteCategoryLink(' + catIdx + ', ' + linkIdx + ')">Löschen</button>'
                      + '</div></div>';
            });
            html += '</div>';
        }
        html += '<button class="btn btn-add-bookmark" onclick="addCategoryLink(' + catIdx + ')">+ Bookmark hinzufügen</button>'
              + '</div></div>'
              + '</div>';
    });
    list.innerHTML = html || '<div class="no-results" style="padding:16px;text-align:center;">Keine Kategorien</div>';
    initDragAndDrop();
}

function renderGeneralBookmarks() {
    const list = document.getElementById('generalBookmarksList');
    if (!list) return;
    let html = '';
    if (allData.bookmarks && allData.bookmarks.length > 0) {
        allData.bookmarks.forEach((bookmark, idx) => {
            html += '<div class="admin-item"><div class="admin-item-content"><div>'
                  + '<div style="font-weight:600;" title="' + escapeHtml(bookmark.name) + '">' + escapeHtml(bookmark.name) + '</div>'
                  + '<div class="admin-item-meta" title="' + escapeHtml(bookmark.url) + '">' + escapeHtml(bookmark.url) + '</div>'
                  + '</div></div><div class="admin-buttons">'
                  + '<button class="btn btn-primary" onclick="editLooseBookmark(' + idx + ')">Bearbeiten</button>'
                  + '<button class="btn btn-danger" onclick="deleteLooseBookmark(' + idx + ')">Löschen</button>'
                  + '</div></div>';
        });
    }
    list.innerHTML = html || '<div class="no-results" style="padding:16px;text-align:center;">Keine losen Bookmarks</div>';
}

// --- import / export / reset / logo upload ----------------------------------

function triggerImport() { if (requireEditable()) document.getElementById('importFileInput').click(); }
function triggerExport() { if (requireEditable()) window.location.href = '/api/bookmarks/export'; }
function triggerLogoUpload() { if (requireEditable()) document.getElementById('logoFileInput').click(); }

async function uploadLogo(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { alert('Logo ist zu groß (max. 10 MB).'); return; }
    try {
        const r = await fetch('/api/logo', {
            method: 'POST',
            headers: { 'Content-Type': file.type },
            body: file,
        });
        await readJson(r);
        bustLogoCache();
        const btn = document.getElementById('manageLogoResetBtn');
        if (btn) btn.hidden = false;
    } catch (e) {
        alert('Logo-Upload fehlgeschlagen: ' + e.message);
    }
}

async function resetLogo() {
    if (!requireEditable()) return;
    if (!confirm('Eigenes Logo entfernen und Standard wiederherstellen?')) return;
    try {
        const r = await fetch('/api/logo', { method: 'DELETE' });
        const result = await readJson(r);
        bustLogoCache();
        const btn = document.getElementById('manageLogoResetBtn');
        if (btn) btn.hidden = result.removed === 0;
    } catch (e) {
        alert('Reset fehlgeschlagen: ' + e.message);
    }
}

function bustLogoCache() {
    const newSrc = '/logo?t=' + Date.now();
    const a = document.getElementById('pageLogo'); if (a) a.src = newSrc;
    const b = document.getElementById('logoPreview'); if (b) b.src = newSrc;
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.href = newSrc;
}

async function resetData() {
    if (!requireEditable()) return;
    if (!confirm('Wirklich alle Bookmarks zurücksetzen? Eine Sicherung wird im Ordner backups angelegt.')) return;
    try {
        await importDoc({ categories: [], tools: [], bookmarks: [] }, 'empty.json');
        await loadData();
    } catch (e) {
        alert('Zurücksetzen fehlgeschlagen: ' + e.message);
    }
}

async function loadExample() {
    if (!requireEditable()) return;
    try {
        const r = await fetch('/bookmarks.example.json');
        if (!r.ok) throw new Error('Beispiel-Datei nicht gefunden');
        const doc = await r.json();
        await importDoc(doc, 'bookmarks.example.json');
        await loadData();
    } catch (e) {
        alert('Beispiel laden fehlgeschlagen: ' + e.message);
    }
}

async function handleImportFile(file) {
    if (!file) return;
    try {
        const text = await file.text();
        const doc = JSON.parse(text);
        if (!doc || !Array.isArray(doc.categories) || !Array.isArray(doc.tools) || !Array.isArray(doc.bookmarks)) {
            throw new Error('JSON muss categories, tools und bookmarks als Arrays enthalten.');
        }
        await importDoc(doc, file.name);
        await loadData();
    } catch (e) {
        alert('Import fehlgeschlagen: ' + e.message);
    }
}

// --- mutation handlers (unified for categories and tools) -------------------

// Save handlers wait for the server before closing the dialog. The dialog
// closes on failure too: the data was reloaded and the indices captured when
// it opened may no longer point at the same entry.
function addCategory() {
    showEditModal('Kategorie hinzufügen', { collapsed: false, sidebar: false }, 'category', async () => {
        const name = document.getElementById('editName').value.trim();
        if (!name) { alert('Bitte einen Namen eingeben'); return; }
        const collapsed = document.getElementById('editCollapsed').checked;
        const sidebar = document.getElementById('editSidebar').checked;
        allData.categories.push({ name, collapsed, sidebar, links: [] });
        await saveData();
        closeEditModal();
    });
}

function editCategoryEntry(idx) {
    const entry = allData.categories[idx];
    const data = { name: entry.name, collapsed: isCollapsed(entry), sidebar: isSidebar(entry) };
    showEditModal('Kategorie bearbeiten', data, 'category', async () => {
        const name = document.getElementById('editName').value.trim();
        if (!name) { alert('Bitte einen Namen eingeben'); return; }
        allData.categories[idx].name = name;
        allData.categories[idx].collapsed = document.getElementById('editCollapsed').checked;
        allData.categories[idx].sidebar = document.getElementById('editSidebar').checked;
        await saveData();
        closeEditModal();
    });
}

function deleteCategoryEntry(idx) {
    const entry = allData.categories[idx];
    if (confirm('Kategorie "' + entry.name + '" wirklich löschen?')) {
        allData.categories.splice(idx, 1);
        saveData();
    }
}

// Reads the name/URL dialog. A URL without scheme ("github.com", typical on the
// phone) gets https:// in front; other schemes are refused, because safeHref
// would turn them into a dead "#" link without any hint.
function readLinkForm() {
    const name = document.getElementById('editName').value.trim();
    let url = document.getElementById('editUrl').value.trim();
    if (!name || !url) { alert('Bitte alle Felder ausfüllen'); return null; }
    // "scheme:" but not "host:port" (e.g. localhost:8080)
    const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(url);
    if (hasScheme && !/^https?:\/\//i.test(url)) {
        alert('Nur Adressen mit http:// oder https:// sind möglich.');
        return null;
    }
    if (!hasScheme && !url.startsWith('/') && !url.startsWith('#')) url = 'https://' + url;
    try { new URL(url, location.href); } catch { alert('Ungültige Adresse: ' + url); return null; }
    return { name, url };
}

function addCategoryLink(catIdx) {
    showEditModal('Bookmark hinzufügen', null, 'link', async () => {
        const link = readLinkForm();
        if (!link) return;
        allData.categories[catIdx].links.push(link);
        await saveData();
        closeEditModal();
    });
}

function editCategoryLink(catIdx, linkIdx) {
    const link = allData.categories[catIdx].links[linkIdx];
    showEditModal('Bookmark bearbeiten', link, 'link', async () => {
        const edited = readLinkForm();
        if (!edited) return;
        allData.categories[catIdx].links[linkIdx] = edited;
        await saveData();
        closeEditModal();
    });
}

function deleteCategoryLink(catIdx, linkIdx) {
    if (confirm('Bookmark wirklich löschen?')) {
        allData.categories[catIdx].links.splice(linkIdx, 1);
        saveData();
    }
}

function addGeneralBookmark() {
    showEditModal('Bookmark hinzufügen', null, 'link', async () => {
        const link = readLinkForm();
        if (!link) return;
        allData.bookmarks.push(link);
        await saveData();
        closeEditModal();
    });
}

function editLooseBookmark(idx) {
    const bookmark = allData.bookmarks[idx];
    showEditModal('Bookmark bearbeiten', bookmark, 'link', async () => {
        const edited = readLinkForm();
        if (!edited) return;
        allData.bookmarks[idx] = edited;
        await saveData();
        closeEditModal();
    });
}

function deleteLooseBookmark(idx) {
    if (confirm('Bookmark "' + allData.bookmarks[idx].name + '" wirklich löschen?')) {
        allData.bookmarks.splice(idx, 1);
        saveData();
    }
}

// --- edit modal -------------------------------------------------------------

function showEditModal(title, data, type, onSave) {
    const editForm = document.getElementById('editForm');
    document.getElementById('editModalTitle').textContent = title;
    let html = '<form onsubmit="event.preventDefault();">';
    if (type === 'category') {
        const collapsedChecked = data && data.collapsed ? ' checked' : '';
        const sidebarChecked = data && data.sidebar ? ' checked' : '';
        html += '<div class="form-group"><label>Name</label>'
              + '<input type="text" id="editName" value="' + escapeHtml(data && data.name || '') + '" placeholder="z.B. Wichtig"></div>'
              + '<div class="form-group">'
              + '<label class="toggle-row">'
              + '<input type="checkbox" id="editCollapsed"' + collapsedChecked + '>'
              + '<span>Eingeklappt anzeigen — Bookmarks erst nach Klick sichtbar</span>'
              + '</label>'
              + '</div>'
              + '<div class="form-group">'
              + '<label class="toggle-row">'
              + '<input type="checkbox" id="editSidebar"' + sidebarChecked + '>'
              + '<span>In der Seitenleiste unter dem Logo anzeigen</span>'
              + '</label>'
              + '</div>';
    } else if (type === 'link') {
        html += '<div class="form-group"><label>Name</label>'
              + '<input type="text" id="editName" value="' + escapeHtml(data && data.name || '') + '" placeholder="z.B. Google"></div>'
              + '<div class="form-group"><label>URL</label>'
              + '<input type="url" id="editUrl" value="' + escapeHtml(data && data.url || '') + '" placeholder="https://example.com"></div>';
    }
    html += '<div class="form-actions">'
          + '<button type="button" class="btn-save" onclick="runSave(this)">Speichern</button>'
          + '<button type="button" class="btn-cancel" onclick="closeEditModal()">Abbrechen</button>'
          + '</div></form>';
    editForm.innerHTML = html;
    window.handleSave = onSave;
    document.getElementById('editModal').classList.add('active');
    setTimeout(() => { const f = document.getElementById('editName'); if (f) f.focus(); }, 50);
}

// Disables the button while the save runs, so a double click can't add the
// same entry twice.
async function runSave(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
        await window.handleSave();
    } finally {
        btn.disabled = false;
    }
}

function closeEditModal() {
    document.getElementById('editModal').classList.remove('active');
}

// --- drag and drop ----------------------------------------------------------

function initDragAndDrop() {
    const items = document.querySelectorAll('#categoriesList [draggable="true"]');
    let draggedElement = null;

    items.forEach(item => {
        item.addEventListener('dragstart', () => {
            draggedElement = item;
            item.style.opacity = '0.5';
        });
        item.addEventListener('dragend', () => {
            if (draggedElement) draggedElement.style.opacity = '1';
            draggedElement = null;
        });
        item.addEventListener('dragover', e => { e.preventDefault(); });
        item.addEventListener('drop', e => {
            e.preventDefault();
            if (!draggedElement || draggedElement === item) return;
            const type = draggedElement.dataset.dragType;
            if (type !== item.dataset.dragType) return; // Kategorien und Links nicht mischen

            if (type === 'category') {
                const cats = allData.categories;
                const [moved] = cats.splice(parseInt(draggedElement.dataset.category, 10), 1);
                cats.splice(parseInt(item.dataset.category, 10), 0, moved);
                saveData();
                return;
            }

            // type === 'link': nur innerhalb derselben Kategorie umsortieren
            const draggedCat = parseInt(draggedElement.dataset.category, 10);
            const draggedIdx = parseInt(draggedElement.dataset.index, 10);
            const dropCat = parseInt(item.dataset.category, 10);
            const dropIdx = parseInt(item.dataset.index, 10);
            if (draggedCat === dropCat) {
                const links = allData.categories[draggedCat].links;
                const [moved] = links.splice(draggedIdx, 1);
                links.splice(dropIdx, 0, moved);
                saveData();
            }
        });
    });
}

// --- collapsed-category modal ----------------------------------------------

function renderToolsList(entry) {
    const toolsList = document.getElementById('toolsList');
    document.getElementById('toolsSearchInput').dataset.currentCategory = JSON.stringify(entry);
    let html = '';
    if (entry && entry.links && entry.links.length > 0) {
        entry.links.forEach(tool => {
            html += '<div class="bookmark-item"><a href="' + safeHref(tool.url) + '" target="_blank" rel="noopener">'
                  + faviconImg(tool.url)
                  + '<span class="name">' + escapeHtml(tool.name) + '</span></a></div>';
        });
    }
    toolsList.innerHTML = html || '<div class="no-results">Keine Einträge vorhanden</div>';
}

// --- event wiring -----------------------------------------------------------

function initializeEventListeners() {
    const modal = document.getElementById('bookmarkModal');
    const editModal = document.getElementById('editModal');
    const toolsModal = document.getElementById('toolsModal');
    const commandBtn = document.getElementById('commandBtn');
    const searchInput = document.getElementById('searchInput');
    const toolsSearchInput = document.getElementById('toolsSearchInput');

    commandBtn.onclick = () => {
        switchTab('bookmarks');
        modal.classList.add('active');
        searchInput.focus();
    };
    document.getElementById('closeBtn').onclick = () => {
        modal.classList.remove('active');
        searchInput.value = '';
    };
    document.getElementById('closeEditBtn').onclick = closeEditModal;
    document.getElementById('closeToolsBtn').onclick = () => {
        toolsModal.classList.remove('active');
        toolsSearchInput.value = '';
    };

    modal.onclick = e => { if (e.target === modal) { modal.classList.remove('active'); searchInput.value = ''; } };
    editModal.onclick = e => { if (e.target === editModal) editModal.classList.remove('active'); };
    toolsModal.onclick = e => { if (e.target === toolsModal) { toolsModal.classList.remove('active'); toolsSearchInput.value = ''; } };

    document.onkeydown = e => {
        if (e.key === 'Escape') {
            if (modal.classList.contains('active')) { modal.classList.remove('active'); searchInput.value = ''; }
            if (editModal.classList.contains('active')) editModal.classList.remove('active');
            if (toolsModal.classList.contains('active')) { toolsModal.classList.remove('active'); toolsSearchInput.value = ''; }
        }
    };

    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.onclick = () => switchTab(btn.dataset.tab);
    });

    searchInput.oninput = e => {
        const query = e.target.value.toLowerCase();
        const bookmarkList = document.getElementById('bookmarkList');
        if (!query) { renderAllBookmarks(); return; }
        const results = (allData.bookmarks || []).filter(b =>
            b.name.toLowerCase().includes(query) || b.url.toLowerCase().includes(query));
        let html = '';
        if (results.length > 0) {
            results.forEach(item => {
                html += '<div class="bookmark-item"><a href="' + safeHref(item.url) + '" target="_blank" rel="noopener">'
                      + faviconImg(item.url)
                      + '<span class="name">' + escapeHtml(item.name) + '</span></a></div>';
            });
        } else {
            html = '<div class="no-results">Keine Ergebnisse gefunden...</div>';
        }
        bookmarkList.innerHTML = html;
    };

    toolsSearchInput.oninput = e => {
        const query = e.target.value.toLowerCase();
        const toolsList = document.getElementById('toolsList');
        const stored = toolsSearchInput.dataset.currentCategory;
        const currentCat = stored ? JSON.parse(stored) : { links: [] };
        if (!query) { renderToolsList(currentCat); return; }
        const results = (currentCat.links || []).filter(t =>
            t.name.toLowerCase().includes(query) || t.url.toLowerCase().includes(query));
        let html = '';
        if (results.length > 0) {
            results.forEach(item => {
                html += '<div class="bookmark-item"><a href="' + safeHref(item.url) + '" target="_blank" rel="noopener">'
                      + faviconImg(item.url)
                      + '<span class="name">' + escapeHtml(item.name) + '</span></a></div>';
            });
        } else {
            html = '<div class="no-results">Keine Ergebnisse gefunden...</div>';
        }
        toolsList.innerHTML = html;
    };

    // Empty state buttons
    document.getElementById('emptyUploadBtn').onclick = triggerImport;
    document.getElementById('emptyExampleBtn').onclick = loadExample;

    // Hidden file inputs
    const importInput = document.getElementById('importFileInput');
    importInput.onchange = e => {
        const file = e.target.files && e.target.files[0];
        handleImportFile(file);
        importInput.value = '';
    };

    const logoInput = document.getElementById('logoFileInput');
    logoInput.onchange = e => {
        const file = e.target.files && e.target.files[0];
        uploadLogo(file);
        logoInput.value = '';
    };
}

document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    // Show the last known state right away (still read-only); loadData
    // replaces it with fresh data, or keeps it and shows the offline banner.
    // Without this the page stays blank until a hanging request times out.
    const snap = readSnapshot();
    if (snap) {
        allData = snap.doc;
        normalizeData();
        renderAll();
    }
    loadData();

    window.addEventListener('online', refreshFromServer);
    window.addEventListener('pageshow', e => { if (e.persisted) refreshFromServer(); });
    document.addEventListener('visibilitychange', refreshFromServer);

    // The service worker keeps the last page for offline use (src/sw.js). It
    // needs a secure context, so plain http://<ip>:8080 simply goes without.
    if ('serviceWorker' in navigator && window.isSecureContext) {
        navigator.serviceWorker.register('/sw.js').catch(e => console.warn('Service Worker:', e));
    }
});
