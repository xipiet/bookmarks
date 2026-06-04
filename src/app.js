let allData = { categories: [], tools: [], bookmarks: [], _meta: {} };

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
    if (!domain) return '';
    const d = escapeHtml(domain);
    return '<img src="https://icons.duckduckgo.com/ip3/' + d + '.ico" alt="" class="favicon" ' +
           'onerror="this.onerror=null;this.src=\'https://www.google.com/s2/favicons?domain=' + d + '&sz=32\'"/>';
}

// A category is "collapsed" if it renders as a clickable tile that opens a
// modal (instead of showing its bookmarks inline). Per-entry flag; missing
// defaults to expanded.
function isCollapsed(entry) {
    return !!(entry && entry.collapsed);
}

// --- data layer -------------------------------------------------------------

// True when the page runs as a local copy (saved via Strg+S, opened as a
// file://). There is no server to talk to, so we read/write the snapshot that
// is embedded in the page itself instead of hitting /api/bookmarks.
function isOfflineCopy() {
    return location.protocol === 'file:';
}

function normalizeData() {
    if (!allData._meta) allData._meta = {};
    if (!Array.isArray(allData.tools)) allData.tools = [];
    if (!Array.isArray(allData.categories)) allData.categories = [];
    if (!Array.isArray(allData.bookmarks)) allData.bookmarks = [];
}

// Read the JSON snapshot embedded in the page (#embeddedData). Written by
// persistEmbeddedData() on every render, so it gets captured when the user
// saves the page with Strg+S. Returns true if usable data was found.
function loadEmbeddedData() {
    const el = document.getElementById('embeddedData');
    if (!el || !el.textContent.trim()) return false;
    try {
        allData = JSON.parse(el.textContent);
        normalizeData();
        return true;
    } catch (e) {
        console.error('Eingebettete Daten unlesbar:', e);
        return false;
    }
}

// Mirror the current data into an inline <script> tag so a Strg+S save keeps a
// self-contained snapshot. `<` is escaped so a bookmark named "</script>" can't
// break out of the tag.
function persistEmbeddedData() {
    let el = document.getElementById('embeddedData');
    if (!el) {
        el = document.createElement('script');
        el.id = 'embeddedData';
        el.type = 'application/json';
        document.body.appendChild(el);
    }
    try {
        el.textContent = JSON.stringify(allData).replace(/</g, '\\u003c');
    } catch (e) {
        console.error('Konnte Daten nicht einbetten:', e);
    }
}

async function loadData() {
    // Local copy without a server: render from the embedded snapshot.
    if (isOfflineCopy()) {
        if (loadEmbeddedData()) renderAll();
        else renderError('Lokale Kopie ohne eingebettete Daten — bitte die Seite erneut über den Server mit Strg+S speichern.');
        return;
    }
    try {
        const response = await fetch('/api/bookmarks');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        allData = await response.json();
        normalizeData();

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
            await saveData();
            return; // saveData re-renders
        }

        renderAll();
    } catch (error) {
        console.error('Error loading bookmarks:', error);
        // Server unreachable: fall back to an embedded snapshot if the page
        // carries one (e.g. a saved copy opened over a non-file:// URL).
        if (loadEmbeddedData()) { renderAll(); return; }
        renderError('Konnte Bookmarks nicht laden: ' + error.message);
    }
}

async function saveData() {
    // In der lokalen Kopie gibt es keinen Server: Änderungen bleiben nur im
    // Speicher (und in der Einbettung), bis erneut mit Strg+S gesichert wird.
    if (isOfflineCopy()) {
        renderAll();
        return;
    }
    try {
        const response = await fetch('/api/bookmarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(allData),
        });
        const result = await response.json();
        if (result.success) {
            if (result._meta) allData._meta = result._meta;
            renderAll();
        } else {
            alert('Speichern fehlgeschlagen: ' + (result.error || 'unbekannter Fehler'));
        }
    } catch (error) {
        console.error('Error saving bookmarks:', error);
        alert('Speichern fehlgeschlagen: ' + error.message);
    }
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
    const result = await response.json();
    if (!result.success) throw new Error(result.error || 'Import fehlgeschlagen');
    return result;
}

// --- rendering --------------------------------------------------------------

function renderAll() {
    renderContent();
    renderAllBookmarks();
    if (isSettingsTabActive()) renderSettingsTab();
    persistEmbeddedData();
}

function renderError(msg) {
    const content = document.getElementById('content');
    content.innerHTML = '<div class="no-results">' + escapeHtml(msg) + '</div>';
}

function isContentEmpty() {
    return (allData.categories || []).length === 0
        && (allData.bookmarks || []).length === 0;
}

function renderContent() {
    const content = document.getElementById('content');
    const emptyState = document.getElementById('emptyState');
    content.innerHTML = '';

    if (isContentEmpty()) {
        emptyState.hidden = false;
        content.hidden = true;
        return;
    }
    emptyState.hidden = true;
    content.hidden = false;

    (allData.categories || []).forEach(entry => {
        if (isCollapsed(entry)) {
            const div = document.createElement('div');
            div.className = 'tool-category';
            div.innerHTML = '<h2>' + escapeHtml(entry.name) + '</h2>';
            div.onclick = () => openCategoryModal(entry);
            content.appendChild(div);
        } else {
            const div = document.createElement('div');
            div.className = 'category';
            const items = (entry.links || []).map(link =>
                '<li><a href="' + safeHref(link.url) + '" target="_blank" rel="noopener">'
                + faviconImg(link.url) + '<span>' + escapeHtml(link.name) + '</span></a></li>'
            ).join('');
            div.innerHTML = '<h2>' + escapeHtml(entry.name) + '</h2><ul>' + items + '</ul>';
            content.appendChild(div);
        }
    });
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
        const mode = isCollapsed(cat) ? 'eingeklappt' : 'ausgeklappt';
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

function triggerImport() { document.getElementById('importFileInput').click(); }
function triggerExport() { window.location.href = '/api/bookmarks/export'; }
function triggerLogoUpload() { document.getElementById('logoFileInput').click(); }

async function uploadLogo(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { alert('Logo ist zu groß (max. 10 MB).'); return; }
    try {
        const r = await fetch('/api/logo', {
            method: 'POST',
            headers: { 'Content-Type': file.type },
            body: file,
        });
        const result = await r.json();
        if (!result.success) throw new Error(result.error || 'Upload fehlgeschlagen');
        bustLogoCache();
        const btn = document.getElementById('manageLogoResetBtn');
        if (btn) btn.hidden = false;
    } catch (e) {
        alert('Logo-Upload fehlgeschlagen: ' + e.message);
    }
}

async function resetLogo() {
    if (!confirm('Eigenes Logo entfernen und Standard wiederherstellen?')) return;
    try {
        const r = await fetch('/api/logo', { method: 'DELETE' });
        const result = await r.json();
        if (!result.success) throw new Error('Reset fehlgeschlagen');
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
    if (!confirm('Wirklich alle Bookmarks zurücksetzen? Eine Sicherung wird in bookmarks.backup.json angelegt.')) return;
    try {
        await importDoc({ categories: [], tools: [], bookmarks: [] }, 'empty.json');
        await loadData();
    } catch (e) {
        alert('Zurücksetzen fehlgeschlagen: ' + e.message);
    }
}

async function loadExample() {
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

function addCategory() {
    showEditModal('Kategorie hinzufügen', { collapsed: false }, 'category', () => {
        const name = document.getElementById('editName').value.trim();
        if (!name) { alert('Bitte einen Namen eingeben'); return; }
        const collapsed = document.getElementById('editCollapsed').checked;
        allData.categories.push({ name, collapsed, links: [] });
        saveData();
        closeEditModal();
    });
}

function editCategoryEntry(idx) {
    const entry = allData.categories[idx];
    showEditModal('Kategorie bearbeiten', { name: entry.name, collapsed: isCollapsed(entry) }, 'category', () => {
        const name = document.getElementById('editName').value.trim();
        if (!name) { alert('Bitte einen Namen eingeben'); return; }
        allData.categories[idx].name = name;
        allData.categories[idx].collapsed = document.getElementById('editCollapsed').checked;
        saveData();
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

function addCategoryLink(catIdx) {
    showEditModal('Bookmark hinzufügen', null, 'link', () => {
        const name = document.getElementById('editName').value.trim();
        const url = document.getElementById('editUrl').value.trim();
        if (!name || !url) { alert('Bitte alle Felder ausfüllen'); return; }
        allData.categories[catIdx].links.push({ name, url });
        saveData();
        closeEditModal();
    });
}

function editCategoryLink(catIdx, linkIdx) {
    const link = allData.categories[catIdx].links[linkIdx];
    showEditModal('Bookmark bearbeiten', link, 'link', () => {
        const name = document.getElementById('editName').value.trim();
        const url = document.getElementById('editUrl').value.trim();
        if (!name || !url) { alert('Bitte alle Felder ausfüllen'); return; }
        allData.categories[catIdx].links[linkIdx] = { name, url };
        saveData();
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
    showEditModal('Bookmark hinzufügen', null, 'link', () => {
        const name = document.getElementById('editName').value.trim();
        const url = document.getElementById('editUrl').value.trim();
        if (!name || !url) { alert('Bitte alle Felder ausfüllen'); return; }
        allData.bookmarks.push({ name, url });
        saveData();
        closeEditModal();
    });
}

function editLooseBookmark(idx) {
    const bookmark = allData.bookmarks[idx];
    showEditModal('Bookmark bearbeiten', bookmark, 'link', () => {
        const name = document.getElementById('editName').value.trim();
        const url = document.getElementById('editUrl').value.trim();
        if (!name || !url) { alert('Bitte alle Felder ausfüllen'); return; }
        allData.bookmarks[idx] = { name, url };
        saveData();
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
        html += '<div class="form-group"><label>Name</label>'
              + '<input type="text" id="editName" value="' + escapeHtml(data && data.name || '') + '" placeholder="z.B. Wichtig"></div>'
              + '<div class="form-group">'
              + '<label class="toggle-row">'
              + '<input type="checkbox" id="editCollapsed"' + collapsedChecked + '>'
              + '<span>Eingeklappt anzeigen — Bookmarks erst nach Klick sichtbar</span>'
              + '</label>'
              + '</div>';
    } else if (type === 'link') {
        html += '<div class="form-group"><label>Name</label>'
              + '<input type="text" id="editName" value="' + escapeHtml(data && data.name || '') + '" placeholder="z.B. Google"></div>'
              + '<div class="form-group"><label>URL</label>'
              + '<input type="url" id="editUrl" value="' + escapeHtml(data && data.url || '') + '" placeholder="https://example.com"></div>';
    }
    html += '<div class="form-actions">'
          + '<button type="button" class="btn-save" onclick="handleSave()">Speichern</button>'
          + '<button type="button" class="btn-cancel" onclick="closeEditModal()">Abbrechen</button>'
          + '</div></form>';
    editForm.innerHTML = html;
    window.handleSave = onSave;
    document.getElementById('editModal').classList.add('active');
    setTimeout(() => { const f = document.getElementById('editName'); if (f) f.focus(); }, 50);
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
    loadData();
});
