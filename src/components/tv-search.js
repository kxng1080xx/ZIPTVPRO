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

export function openSearchKeyboard({ title = 'Search', initial = '', onChange, onClose } = {}) {
  closeSearchKeyboard(); // ensure single instance

  const overlay = document.createElement('div');
  overlay.className = 'tvk-overlay';
  overlay.innerHTML = `
    <div class="tvk-modal">
      <div class="tvk-header">
        <span class="tvk-title"><i data-lucide="search"></i> ${title}</span>
        <button class="tvk-close" title="Close"><i data-lucide="x"></i></button>
      </div>
      <div class="tvk-query">
        <input class="tvk-input" type="text" placeholder="Type to search…"
               autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false">
      </div>
      <div class="tvk-keys"></div>
      <div class="tvk-hint"></div>
    </div>`;
  document.body.appendChild(overlay);

  // Portrait (phones): use the device keyboard. Landscape/TV: on-screen keyboard.
  const isPortrait = (() => { try { return window.matchMedia('(orientation: portrait)').matches; } catch (e) { return false; } })();
  if (isPortrait) overlay.classList.add('tvk-device-mode');

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
    deviceMode: isPortrait,
    input: overlay.querySelector('.tvk-input')
  };

  // Text input accepts typing from the device (or a physical) keyboard, in
  // addition to the on-screen keys.
  kb.input.value = kb.query;
  kb.input.addEventListener('input', (e) => { kb.query = e.target.value; emitChange(); });
  kb.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } });

  overlay.querySelector('.tvk-close').addEventListener('click', () => done());
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
  if (kb.deviceMode) {
    if (hint) hint.textContent = 'Type with your keyboard';
    // Pop the device keyboard.
    setTimeout(() => { try { kb.input.focus(); } catch (e) {} }, 60);
  } else {
    if (hint) hint.textContent = 'Arrows to move • OK to type • Back to close';
    focusCurrent();
  }
  lucide(overlay);
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

  // When the text input has focus (device / physical keyboard), let it handle
  // everything — only Escape closes. Enter is handled by the input's own
  // listener. This keeps device-keyboard typing working alongside the overlay.
  if (document.activeElement === kb.input) {
    if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(); }
    return;
  }

  const isNav = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Backspace', 'Escape'].includes(k);
  if (!isNav) return; // let physical-keyboard typing fall through if ever present
  e.preventDefault();
  e.stopImmediatePropagation(); // keep the global TV nav out of this overlay

  if (k === 'Escape' || k === 'Backspace') { done(); return; }
  if (k === 'Enter' || k === ' ') {
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
