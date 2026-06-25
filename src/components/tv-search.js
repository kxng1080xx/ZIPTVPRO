/**
 * TV-navigable Search + Sort, with NO native text fields (a focused <input> pops
 * the on-screen IME even when you're just scrolling past it). Instead:
 *   - openSearchKeyboard(): an on-screen A-Z/0-9 keyboard you drive with the
 *     D-pad; each key filters live. Back/Done closes, leaving results filtered.
 *   - openSortDropdown(): a D-pad up/down list of sort options.
 *
 * Both are self-contained overlays that capture keydown (capture phase +
 * stopImmediatePropagation) so the global TV navigation doesn't also react.
 */

const KEY_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
  ['SPACE', 'BACK', 'CLEAR', 'DONE']
];

const SPECIAL_LABEL = {
  SPACE: 'Space',
  BACK: '⌫',
  CLEAR: 'Clear',
  DONE: 'Done'
};

let kb = null;

function lucide(scope) {
  if (window.lucide) { try { window.lucide.createIcons({ scope }); } catch (e) {} }
}

// Running inside the Electron desktop build (the .exe)? The preload exposes
// these bridges; they're absent on web / Android.
function isElectron() {
  return !!(window.electronCast || window.appHost);
}

export function openSearchKeyboard({ title = 'Search', initial = '', onChange, onClose } = {}) {
  closeSearchKeyboard(); // ensure single instance

  const overlay = document.createElement('div');
  overlay.className = 'tvk-overlay';
  overlay.innerHTML = `
    <div class="tvk-modal">
      <div class="tvk-header">
        <span class="tvk-title"><i data-lucide="search"></i> ${title}</span>
        <div class="tvk-header-btns">
          <button class="tvk-toggle" title="Hide on-screen keyboard"><i data-lucide="keyboard"></i></button>
          <button class="tvk-close" title="Close"><i data-lucide="x"></i></button>
        </div>
      </div>
      <div class="tvk-query">
        <input class="tvk-input" type="text" placeholder="Type to search…" tabindex="-1"
               readonly inputmode="none"
               autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false">
      </div>
      <div class="tvk-keys"></div>
      <div class="tvk-hint"></div>
    </div>`;
  document.body.appendChild(overlay);

  // The on-screen keyboard is always shown (touch users tap it; D-pad users
  // drive it; physical-keyboard users can also just type — see kbKeyHandler).
  // On the PC build (.exe) you usually have a real keyboard, so we offer a
  // toggle to collapse the on-screen keys out of the way.
  const electron = isElectron();
  if (electron) overlay.classList.add('tvk-can-hide');

  // Build key grid (each cell carries its row/col for D-pad movement).
  const keysEl = overlay.querySelector('.tvk-keys');
  KEY_ROWS.forEach((row, r) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'tvk-row';
    row.forEach((k, c) => {
      const btn = document.createElement('button');
      btn.className = 'tvk-key' + (SPECIAL_LABEL[k] ? ' tvk-key-special tvk-key-' + k.toLowerCase() : '');
      btn.dataset.key = k;
      btn.dataset.r = r;
      btn.dataset.c = c;
      btn.textContent = SPECIAL_LABEL[k] || k;
      rowEl.appendChild(btn);
    });
    keysEl.appendChild(rowEl);
  });

  kb = {
    overlay,
    onChange,
    onClose,
    query: initial || '',
    r: 1,
    c: 0,
    changeTimer: null,
    // On the PC build a physical keyboard is the norm, so collapse the tap-keys
    // by default (the toggle still restores them). Touch/D-pad builds keep them.
    keysHidden: electron,
    input: overlay.querySelector('.tvk-input')
  };

  // Reflect the default-collapsed state on the PC build.
  if (kb.keysHidden) {
    overlay.classList.add('tvk-keys-collapsed');
    const tBtn = overlay.querySelector('.tvk-toggle');
    if (tBtn) {
      tBtn.title = 'Show on-screen keyboard';
      tBtn.innerHTML = '<i data-lucide="keyboard"></i>';
    }
  }

  // The input is a read-only display of the query (it never receives focus, so
  // it never pops the native Android IME — we want our own on-screen keyboard
  // shown instead). All typing flows through kbKeyHandler.
  kb.input.value = kb.query;

  overlay.querySelector('.tvk-close').addEventListener('click', () => done());
  const toggleBtn = overlay.querySelector('.tvk-toggle');
  if (toggleBtn) toggleBtn.addEventListener('click', () => toggleKeys());
  overlay.querySelectorAll('.tvk-key').forEach((btn) => {
    btn.addEventListener('click', () => {
      kb.r = parseInt(btn.dataset.r, 10);
      kb.c = parseInt(btn.dataset.c, 10);
      pressKey(btn.dataset.key);
      focusCurrent();
    });
  });

  document.addEventListener('keydown', kbKeyHandler, true);
  renderQuery();

  const hint = overlay.querySelector('.tvk-hint');
  if (hint) {
    hint.textContent = electron
      ? 'Type on your keyboard • or tap keys • Esc to close'
      : 'Type on your keyboard • arrows + OK • tap keys • Back to close';
  }
  focusCurrent();
  lucide(overlay);
}

// Collapse / restore the on-screen keys (PC build, where a physical keyboard is
// the norm). Physical typing keeps working either way via kbKeyHandler.
function toggleKeys() {
  if (!kb) return;
  kb.keysHidden = !kb.keysHidden;
  kb.overlay.classList.toggle('tvk-keys-collapsed', kb.keysHidden);
  const btn = kb.overlay.querySelector('.tvk-toggle');
  if (btn) {
    btn.title = kb.keysHidden ? 'Show on-screen keyboard' : 'Hide on-screen keyboard';
    btn.innerHTML = kb.keysHidden
      ? '<i data-lucide="keyboard"></i>'
      : '<i data-lucide="keyboard-off"></i>';
    lucide(btn);
  }
  if (!kb.keysHidden) focusCurrent();
}

export function closeSearchKeyboard() {
  if (!kb) return;
  document.removeEventListener('keydown', kbKeyHandler, true);
  clearTimeout(kb.changeTimer);
  kb.overlay.remove();
  kb = null;
}

function renderQuery() {
  if (!kb) return;
  // Keep the text input in sync (on-screen keys edit it too).
  if (kb.input && kb.input.value !== kb.query) kb.input.value = kb.query;
}

function emitChange() {
  if (!kb || !kb.onChange) return;
  clearTimeout(kb.changeTimer);
  const q = kb.query;
  kb.changeTimer = setTimeout(() => { if (kb) kb.onChange(q); }, 250);
}

function pressKey(key) {
  if (!kb) return;
  if (key === 'BACK') {
    kb.query = kb.query.slice(0, -1);
  } else if (key === 'CLEAR') {
    kb.query = '';
  } else if (key === 'SPACE') {
    kb.query += ' ';
  } else if (key === 'DONE') {
    done();
    return;
  } else {
    kb.query += key;
  }
  renderQuery();
  emitChange();
}

function done() {
  if (!kb) return;
  const cb = kb.onClose;
  const q = kb.query;
  // flush a pending debounce so results are final before close
  if (kb.onChange) kb.onChange(q);
  closeSearchKeyboard();
  if (cb) cb(q);
}

function keyAt(r, c) {
  if (!kb) return null;
  return kb.overlay.querySelector(`.tvk-key[data-r="${r}"][data-c="${c}"]`);
}

function focusCurrent() {
  if (!kb) return;
  const rowLen = KEY_ROWS[kb.r].length;
  if (kb.c >= rowLen) kb.c = rowLen - 1;
  kb.overlay.querySelectorAll('.tvk-key').forEach((b) => b.classList.remove('tvk-focused'));
  const el = keyAt(kb.r, kb.c);
  if (el) {
    el.classList.add('tvk-focused');
    try { el.focus({ preventScroll: true }); } catch (e) {}
  }
}

function kbKeyHandler(e) {
  if (!kb) return;
  const k = e.key;

  // Physical keyboard (PC .exe or a hardware/Bluetooth keyboard on the APK):
  // printable single characters type straight into the query, alongside the
  // on-screen keys. Ignore modifier combos (Ctrl/Alt/Cmd shortcuts).
  if (k && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (k === ' ') { pressKey('SPACE'); } else { kb.query += k; renderQuery(); emitChange(); }
    return;
  }

  const isNav = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Backspace', 'Escape'].includes(k);
  if (!isNav) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // keep the global TV nav out of this overlay

  if (k === 'Escape') { done(); return; }
  if (k === 'Backspace') { pressKey('BACK'); return; } // physical Backspace deletes a character
  if (k === 'Enter') {
    const el = keyAt(kb.r, kb.c);
    if (el) pressKey(el.dataset.key);
    focusCurrent();
    return;
  }
  if (k === 'ArrowLeft') { kb.c = Math.max(0, kb.c - 1); focusCurrent(); return; }
  if (k === 'ArrowRight') { kb.c = Math.min(KEY_ROWS[kb.r].length - 1, kb.c + 1); focusCurrent(); return; }
  if (k === 'ArrowUp') { kb.r = Math.max(0, kb.r - 1); focusCurrent(); return; }
  if (k === 'ArrowDown') { kb.r = Math.min(KEY_ROWS.length - 1, kb.r + 1); focusCurrent(); return; }
}

// --------------------------------------------------------------------------
// Sort dropdown
// --------------------------------------------------------------------------
let sd = null;

export function openSortDropdown({ title = 'Sort by', options = [], current, onSelect } = {}) {
  closeSortDropdown();

  const overlay = document.createElement('div');
  overlay.className = 'tvsort-overlay';
  overlay.innerHTML = `
    <div class="tvsort-modal">
      <div class="tvsort-title">${title}</div>
      <div class="tvsort-list"></div>
    </div>`;
  document.body.appendChild(overlay);

  const list = overlay.querySelector('.tvsort-list');
  options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'tvsort-item' + (opt.value === current ? ' selected' : '');
    btn.dataset.value = opt.value;
    btn.dataset.i = i;
    btn.innerHTML = `<span>${opt.label}</span>${opt.value === current ? '<i data-lucide="check"></i>' : ''}`;
    btn.addEventListener('click', () => choose(opt.value));
    list.appendChild(btn);
  });

  sd = { overlay, options, onSelect, i: Math.max(0, options.findIndex((o) => o.value === current)) };

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSortDropdown(); });
  document.addEventListener('keydown', sdKeyHandler, true);
  focusSort();
  lucide(overlay);
}

export function closeSortDropdown() {
  if (!sd) return;
  document.removeEventListener('keydown', sdKeyHandler, true);
  sd.overlay.remove();
  sd = null;
}

function choose(value) {
  if (!sd) return;
  const cb = sd.onSelect;
  closeSortDropdown();
  if (cb) cb(value);
}

function focusSort() {
  if (!sd) return;
  const items = sd.overlay.querySelectorAll('.tvsort-item');
  items.forEach((b) => b.classList.remove('tvk-focused'));
  const el = items[sd.i];
  if (el) { el.classList.add('tvk-focused'); try { el.focus({ preventScroll: true }); } catch (e) {} }
}

function sdKeyHandler(e) {
  if (!sd) return;
  const k = e.key;
  if (!['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Escape', 'Backspace'].includes(k)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (k === 'Escape' || k === 'Backspace') { closeSortDropdown(); return; }
  if (k === 'Enter' || k === ' ') { choose(sd.options[sd.i].value); return; }
  if (k === 'ArrowUp') { sd.i = Math.max(0, sd.i - 1); focusSort(); return; }
  if (k === 'ArrowDown') { sd.i = Math.min(sd.options.length - 1, sd.i + 1); focusSort(); return; }
}
