import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { closeSearchKeyboard, closeSortDropdown } from './tv-search.js';

/**
 * TV Navigation Coordinator for Arrow Key & Enter Button Navigation.
 * Enables full remote control (keyboard equivalent) usage.
 */

class TVNavigation {
  constructor() {
    this.currentZone = 'categories'; // 'tabs', 'categories', 'channels', 'grid', 'player', 'modal'
    this.focusedElement = null;
    this.pendingZone = null;
    this.pendingFocus = null;
    
    // Key codes map
    this.KEYS = {
      UP: 'ArrowUp',
      DOWN: 'ArrowDown',
      LEFT: 'ArrowLeft',
      RIGHT: 'ArrowRight',
      ENTER: 'Enter',
      BACKSPACE: 'Backspace',
      ESCAPE: 'Escape',
      SPACE: ' '
    };
    
    this.init();
  }

  init() {
    window.addEventListener('keydown', (e) => this.handleKeyDown(e));

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) {
        if (document.body.classList.contains('vod-mode')) {
          const backBtn = document.getElementById('player-back-btn');
          if (backBtn) {
            backBtn.click();
            return;
          }
        }

        const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
        if (activeTab === 'live') {
          this.focusDefault('channels');
        } else if (activeTab === 'series') {
          const playbackOpen = !document.getElementById('series-playback-container')?.classList.contains('hidden');
          if (playbackOpen) {
            this.focusDefault('series-episodes');
          } else {
            this.focusDefault('grid');
          }
        } else {
          this.focusDefault('grid');
        }
      } else {
        this.focusDefault('player');
      }
    });

    if (Capacitor.isNativePlatform()) {
      App.addListener('backButton', () => this.handleBack());
    }
  }

  // Hardware / remote BACK: undo the last step instead of exiting. Walks up the
  // UI hierarchy (overlay → fullscreen → player → list → categories → tabs) and
  // only exits the app on a confirmed double-back at the root.
  handleBack() {
    // 1) Transient overlays — close the topmost first.
    if (document.querySelector('.tvk-overlay')) { closeSearchKeyboard(); return; }
    if (document.querySelector('.tvsort-overlay')) { closeSortDropdown(); return; }

    const updateOverlay = document.getElementById('update-modal-overlay');
    if (updateOverlay) {
      // Click Cancel so the modal's own cleanup (key listener removal) runs.
      const cancel = updateOverlay.querySelector('[data-action="cancel"]');
      if (cancel) cancel.click(); else updateOverlay.remove();
      this.restoreBackgroundFocus();
      return;
    }

    const castOverlay = document.querySelector('.cast-modal-overlay:not(.hidden)');
    if (castOverlay) { castOverlay.classList.add('hidden'); return; }

    const dropdown = document.querySelector('.playlist-dropdown:not(.hidden)');
    if (dropdown) { dropdown.classList.add('hidden'); this.focusDefault('tabs'); return; }

    const activeModal = document.querySelector('.modal-overlay:not(.hidden)');
    if (activeModal) {
      const closeBtn = activeModal.querySelector('.modal-close-btn');
      if (closeBtn) closeBtn.click(); else activeModal.classList.add('hidden');
      this.focusDefault(activeModal.id === 'vod-modal' ? 'grid' : 'tabs');
      return;
    }

    // 2) Fullscreen video → drop back to the list, don't exit.
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }

    // 3) Full-screen EPG guide.
    if (document.body.classList.contains('epg-fullscreen-active')) {
      const fullBtn = document.getElementById('epg-full-btn');
      if (fullBtn) fullBtn.click();
      return;
    }

    // 4) VOD player overlay (movie playing) → back to the catalog grid.
    if (document.body.classList.contains('vod-mode')) {
      const backBtn = document.getElementById('player-back-btn');
      if (backBtn) { backBtn.click(); this.focusDefault('grid'); return; }
    }

    // 5) Series playback dashboard → back to the series catalog.
    const seriesPlayback = document.getElementById('series-playback-container');
    if (seriesPlayback && !seriesPlayback.classList.contains('hidden')) {
      const sb = document.getElementById('series-back-btn');
      if (sb) { sb.click(); this.focusDefault('grid'); return; }
    }

    // 6) Walk up the focus hierarchy.
    switch (this.currentZone) {
      case 'player':
        this.focusDefault('channels');
        return;
      case 'channels':
      case 'grid':
      case 'series-episodes':
        this.focusDefault('categories');
        return;
      case 'categories':
        this.focusDefault('tabs');
        return;
      case 'tabs':
      default:
        this.confirmExit();
        return;
    }
  }

  // Require two quick BACK presses at the root to exit (with a toast hint).
  confirmExit() {
    if (this._armedExit) {
      clearTimeout(this._armedExitTimer);
      if (Capacitor.isNativePlatform()) App.exitApp();
      return;
    }
    this._armedExit = true;
    this.showBackToast('Press back again to exit');
    clearTimeout(this._armedExitTimer);
    this._armedExitTimer = setTimeout(() => { this._armedExit = false; }, 2200);
  }

  showBackToast(msg) {
    let t = document.getElementById('back-exit-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'back-exit-toast';
      t.className = 'back-exit-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
  }

  // Set focus to a specific element within a zone
  setFocus(zone, element) {
    if (!element) return;

    // Trap focus inside active overlays/modals (block background focus stealing)
    const updateOverlay = document.getElementById('update-modal-overlay');
    if (updateOverlay && !updateOverlay.contains(element)) {
      console.log(`[TV Navigation] Focus blocked: update modal is open. Blocked zone: ${zone}`);
      this.pendingFocus = { zone, element };
      return;
    }

    const activeModal = document.querySelector('.modal-overlay:not(.hidden)');
    if (activeModal && !activeModal.contains(element)) {
      console.log(`[TV Navigation] Focus blocked: active modal is open. Blocked zone: ${zone}`);
      this.pendingFocus = { zone, element };
      return;
    }

    const castOverlay = document.querySelector('.cast-modal-overlay:not(.hidden)');
    if (castOverlay && !castOverlay.contains(element)) {
      console.log(`[TV Navigation] Focus blocked: cast overlay is open. Blocked zone: ${zone}`);
      this.pendingFocus = { zone, element };
      return;
    }

    // Remove focus class from previous element
    if (this.focusedElement) {
      this.focusedElement.classList.remove('tv-focused');
    }

    this.currentZone = zone;
    this.focusedElement = element;
    this.focusedElement.classList.add('tv-focused');
    
    // Clear pending focus/zone on successful focus
    this.pendingFocus = null;
    this.pendingZone = null;

    // Scroll into view if scrollable (use 'auto' / instant to prevent queueing animations and layout freezes on Smart TVs)
    this.focusedElement.scrollIntoView({
      behavior: 'auto',
      block: 'nearest',
      inline: 'nearest'
    });

    // Custom robust scroll into view helper to fix WebView/SmartTV scroll issues
    this.ensureVisibleInScrollParent(element);

    // Native focus management to prevent Smart TV/Android Webview focus stealing/keyboard popups
    if (element.tagName !== 'INPUT') {
      if (!element.hasAttribute('tabindex')) {
        element.setAttribute('tabindex', '-1');
      }
      try {
        element.focus({ preventScroll: true });
      } catch (err) {
        element.focus();
      }
    } else {
      const activeEl = document.activeElement;
      if (activeEl && activeEl !== document.body) {
        activeEl.blur();
      }
    }

    console.log(`TV Focus -> Zone: ${zone}, Element:`, element.textContent?.trim() || element.className);
  }

  // Remove focus entirely
  clearFocus() {
    if (this.focusedElement) {
      this.focusedElement.classList.remove('tv-focused');
      this.focusedElement = null;
    }
  }

  // Ensure element is visible in its closest scrollable parent
  ensureVisibleInScrollParent(element) {
    if (!element) return;
    
    // Find closest parent that has overflow-y auto/scroll
    let parent = element.parentElement;
    while (parent && parent !== document.body) {
      const style = window.getComputedStyle(parent);
      const overflowY = style.getPropertyValue('overflow-y');
      const isScrollable = (overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight;
      
      if (isScrollable) {
        const parentRect = parent.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const padding = 6; // small padding from container edge
        
        if (elementRect.top < parentRect.top + padding) {
          // Scrolled above: align top
          parent.scrollTop -= (parentRect.top + padding - elementRect.top);
        } else if (elementRect.bottom > parentRect.bottom - padding) {
          // Scrolled below: align bottom
          parent.scrollTop += (elementRect.bottom - (parentRect.bottom - padding));
        }
        break; // Only scroll the nearest scrollable parent
      }
      parent = parent.parentElement;
    }
  }

  triggerPendingFocus() {
    if (this.pendingZone) {
      const zone = this.pendingZone;
      this.focusDefault(zone);
    }
  }

  // Automatically focus the default element when views switch
  focusDefault(zone) {
    this.pendingZone = zone;

    if (zone === 'categories') {
      const activeCat = document.querySelector('.category-item.active') || document.querySelector('.category-item');
      if (activeCat) {
        this.setFocus('categories', activeCat);
        return;
      }
    } else if (zone === 'channels') {
      const firstChan = document.querySelector('.epg-channel-row');
      if (firstChan) {
        this.setFocus('channels', firstChan);
        return;
      }
    } else if (zone === 'tabs') {
      const activeTab = document.querySelector('.nav-tab.active') || document.querySelector('.nav-tab');
      if (activeTab) {
        this.setFocus('tabs', activeTab);
        return;
      }
    } else if (zone === 'grid') {
      // VOD Grid: query only active grid to avoid selecting hidden card elements
      const firstCard = document.querySelector('.view-panel.active .vod-grid .vod-card');
      if (firstCard) {
        this.setFocus('grid', firstCard);
        return;
      }
    } else if (zone === 'player') {
      const isFullscreen = !!document.fullscreenElement;
      if (isFullscreen) {
        const playBtn = document.getElementById('player-play-pause-btn');
        if (playBtn) {
          this.setFocus('player', playBtn);
          return;
        }
      }
      const player = document.getElementById('video-container');
      if (player) {
        this.setFocus('player', player);
        return;
      }
    } else if (zone === 'series-episodes') {
      const activeEp = document.querySelector('.episode-list-row.active') || document.querySelector('.episode-list-row');
      if (activeEp) {
        this.setFocus('series-episodes', activeEp);
        return;
      }
      const select = document.getElementById('series-season-select');
      if (select) {
        this.setFocus('series-episodes', select);
        return;
      }
    } else if (zone === 'login') {
      // If remote-login-box is visible, focus the Manual Login button first
      const remoteBox = document.getElementById('remote-login-box');
      const manualBtn = document.getElementById('remote-manual-login-btn');
      if (remoteBox && remoteBox.offsetParent !== null && manualBtn && manualBtn.offsetParent !== null) {
        this.setFocus('login', manualBtn);
        return;
      }
      // Otherwise default to the first input on manual form
      const firstInput = document.getElementById('playlist-name') || document.getElementById('m3u-url');
      if (firstInput) {
        this.setFocus('login', firstInput);
        return;
      }
    } else if (zone === 'playlist-select') {
      const firstRow = document.querySelector('#login-playlists-list .playlist-row');
      console.log('focusDefault playlist-select: found firstRow?', !!firstRow);
      if (firstRow) {
        this.setFocus('playlist-select', firstRow);
        return;
      }
      const addBtn = document.getElementById('login-show-form-btn');
      if (addBtn) {
        this.setFocus('playlist-select', addBtn);
        return;
      }
    } else if (zone === 'playlist-dropdown') {
      const firstRow = document.querySelector('#playlist-dropdown-list .playlist-row');
      if (firstRow) {
        this.setFocus('playlist-dropdown', firstRow);
        return;
      }
      const addBtn = document.getElementById('playlist-add-btn');
      if (addBtn) {
        this.setFocus('playlist-dropdown', addBtn);
        return;
      }
    }
    
    this.clearFocus();
  }

  restoreBackgroundFocus() {
    if (this.pendingFocus && this.pendingFocus.element && document.body.contains(this.pendingFocus.element)) {
      console.log('[TV Navigation] Restoring pending focus to:', this.pendingFocus.zone);
      this.setFocus(this.pendingFocus.zone, this.pendingFocus.element);
      return;
    }
    if (this.pendingZone) {
      console.log('[TV Navigation] Restoring pending zone to:', this.pendingZone);
      this.focusDefault(this.pendingZone);
      return;
    }
    // Fallback check based on what is visible
    const loginScreen = document.getElementById('login-screen');
    const loginVisible = loginScreen && !loginScreen.classList.contains('hidden');
    if (loginVisible) {
      const playlistSelect = document.getElementById('login-playlist-select');
      const playlistSelectVisible = playlistSelect && !playlistSelect.classList.contains('hidden');
      if (playlistSelectVisible) {
        this.focusDefault('playlist-select');
      } else {
        this.focusDefault('login');
      }
    } else {
      this.focusDefault('categories');
    }
  }

  handleKeyDown(e) {
    // If the video player is in fullscreen, pressing Backspace or Escape exits fullscreen
    if (document.fullscreenElement && (e.key === this.KEYS.ESCAPE || e.key === this.KEYS.BACKSPACE)) {
      document.exitFullscreen().catch(err => console.warn(err));
      e.preventDefault();
      return;
    }

    const activeEl = document.activeElement;
    const updateOverlay = document.getElementById('update-modal-overlay');
    const activeModal = document.querySelector('.modal-overlay:not(.hidden)');
    const castOverlay = document.querySelector('.cast-modal-overlay:not(.hidden)');
    
    const activeContainer = updateOverlay || activeModal || castOverlay;
    const insideActiveContainer = activeContainer && activeContainer.contains(activeEl);

    // Ignore TV navigation if user is typing in active text inputs
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
      if (activeContainer && !insideActiveContainer) {
        activeEl.blur();
      } else if (!activeContainer || insideActiveContainer) {
        const isLoginInput = ['playlist-name', 'm3u-url', 'host-url', 'username', 'password'].includes(activeEl.id);
        if (isLoginInput && (e.key === this.KEYS.UP || e.key === this.KEYS.DOWN)) {
          activeEl.blur();
          // Fall through to navigation below
        } else {
          if (e.key === this.KEYS.ENTER && activeEl.id === 'categories-search') {
            activeEl.blur();
            this.focusDefault('categories');
            e.preventDefault();
          }
          return; // Let standard input consume key
        }
      }
    }

    // Recovery: if focused element is null or detached from DOM, restore default focus for current zone
    if (!this.focusedElement || !document.body.contains(this.focusedElement)) {
      console.warn(`TV Focus lost or detached from DOM (zone: ${this.currentZone}). Recovering...`);
      if (updateOverlay) {
        const btns = Array.from(updateOverlay.querySelectorAll('.update-btn'));
        if (btns.length > 0) this.setFocus('update-modal', btns[btns.length - 1]);
      } else if (activeModal) {
        this.focusDefault('modal');
      } else {
        this.focusDefault(this.currentZone);
      }
    }

    // Update-available prompt is the topmost overlay — trap the D-pad here so it
    // doesn't navigate the UI behind it.
    if (updateOverlay) {
      this.handleUpdateModalNavigation(e, updateOverlay);
      return;
    }

    // Modal check (VOD or Settings overlay)
    if (activeModal) {
      this.handleModalNavigation(e, activeModal);
      return;
    }

    const activeDropdown = document.querySelector('.playlist-dropdown:not(.hidden)');
    if (activeDropdown) {
      this.handlePlaylistDropdownNavigation(e);
      return;
    }

    // Back / Escape leaves full-screen EPG from anywhere (TV remote Back maps here).
    if (document.body.classList.contains('epg-fullscreen-active') &&
        (e.key === this.KEYS.ESCAPE || e.key === this.KEYS.BACKSPACE)) {
      const fullBtn = document.getElementById('epg-full-btn');
      if (fullBtn) fullBtn.click();
      e.preventDefault();
      return;
    }

    switch (this.currentZone) {
      case 'tabs':
        this.handleTabsNavigation(e);
        break;
      case 'playlist-dropdown':
        this.handlePlaylistDropdownNavigation(e);
        break;
      case 'categories':
        this.handleCategoriesNavigation(e);
        break;
      case 'channels':
        this.handleChannelsNavigation(e);
        break;
      case 'grid':
        this.handleGridNavigation(e);
        break;
      case 'player':
        this.handlePlayerNavigation(e);
        break;
      case 'series-episodes':
        this.handleSeriesEpisodesNavigation(e);
        break;
      case 'login':
        this.handleLoginFormNavigation(e);
        break;
      case 'playlist-select':
        this.handlePlaylistSelectNavigation(e);
        break;
      default:
        // Default recovery
        this.focusDefault('categories');
        break;
    }
  }

  // 1. TABS HEADER NAVIGATION
  handleTabsNavigation(e) {
    const tabs = Array.from(document.querySelectorAll('.nav-tab'));
    const profileBtn = document.getElementById('profile-card-btn');
    const syncBtn = document.getElementById('sync-btn');
    const settingsBtn = document.getElementById('settings-btn');
    
    const headerItems = [...tabs];
    if (profileBtn && profileBtn.offsetParent !== null) headerItems.push(profileBtn);
    if (syncBtn && syncBtn.offsetParent !== null) headerItems.push(syncBtn);
    if (settingsBtn && settingsBtn.offsetParent !== null) headerItems.push(settingsBtn);

    const index = headerItems.indexOf(this.focusedElement);
    if (index === -1) return;

    if (e.key === this.KEYS.LEFT) {
      // Only move the focus highlight between header items. Do NOT switch/load
      // the tab on pass-through — the user must press Enter to select it.
      // Otherwise scrolling past Movies/Series (e.g. on the way to Settings)
      // would load those tabs and reset navigation.
      if (index > 0) {
        this.setFocus('tabs', headerItems[index - 1]);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT) {
      if (index < headerItems.length - 1) {
        this.setFocus('tabs', headerItems[index + 1]);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.DOWN) {
      // Move down to category sidebar
      this.focusDefault('categories');
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      this.focusedElement.click();
      e.preventDefault();
    }
  }

  // 2. CATEGORIES SIDEBAR NAVIGATION
  handleCategoriesNavigation(e) {
    const pinToggle = document.getElementById('pin-section-toggle');
    const searchBtn = document.getElementById('categories-search-btn');
    const items = Array.from(document.querySelectorAll('#categories-list .category-item:not(.hidden)'));
    const pinItems = Array.from(document.querySelectorAll('.pin-item'));

    // Top-to-bottom focus order: the "Pin top section" header, the pinned items
    // (only when the section is expanded/visible), the search button, then categories.
    const allItems = [];
    if (pinToggle) allItems.push(pinToggle);
    pinItems.forEach(p => { if (p.offsetParent !== null) allItems.push(p); });
    if (searchBtn && searchBtn.offsetParent !== null) allItems.push(searchBtn);
    allItems.push(...items);

    const index = allItems.indexOf(this.focusedElement);
    if (index === -1) return;

    if (e.key === this.KEYS.DOWN) {
      if (index < allItems.length - 1) {
        const nextEl = allItems[index + 1];
        this.setFocus('categories', nextEl);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      if (index > 0) {
        const prevEl = allItems[index - 1];
        this.setFocus('categories', prevEl);
      } else {
        // Focus top navbar tabs
        this.focusDefault('tabs');
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT || e.key === this.KEYS.ENTER) {
      const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
      const playbackOpen = !document.getElementById('series-playback-container')?.classList.contains('hidden');

      if (this.focusedElement.id === 'pin-section-toggle') {
        if (e.key === this.KEYS.ENTER) {
          // Collapse/expand the pinned section and stay on the header.
          this.focusedElement.click();
        } else {
          // Right arrow moves into the content area.
          if (activeTab === 'live') {
            this.focusDefault('channels');
          } else if (activeTab === 'series' && playbackOpen) {
            this.focusDefault('series-episodes');
          } else {
            this.focusDefault('grid');
          }
        }
      } else if (this.focusedElement.id === 'categories-search-btn') {
        if (e.key === this.KEYS.ENTER) {
          this.focusedElement.click(); // Open the D-pad keyboard overlay
        } else {
          // Right arrow moves focus directly
          if (activeTab === 'live') {
            this.focusDefault('channels');
          } else if (activeTab === 'series' && playbackOpen) {
            this.focusDefault('series-episodes');
          } else {
            this.focusDefault('grid');
          }
        }
      } else {
        // Select category and jump
        this.focusedElement.click();
        
        if (activeTab === 'live') {
          this.focusDefault('channels');
        } else if (activeTab === 'series' && playbackOpen) {
          this.focusDefault('series-episodes');
        } else {
          this.focusDefault('grid');
        }
      }
      e.preventDefault();
    }
  }

  // 3. EPG CHANNELS LIST NAVIGATION (LIVE TV)
  handleChannelsNavigation(e) {
    // EPG control buttons (Search/Filter/Refresh…) live above the channel list,
    // in the same 'channels' zone.
    if (this.focusedElement.classList.contains('epg-ctrl-btn')) {
      this.handleEpgControlsNavigation(e);
      return;
    }

    const channels = Array.from(document.querySelectorAll('.epg-channels-column .epg-channel-row'));
    const index = channels.indexOf(this.focusedElement);
    if (index === -1) return;

    if (e.key === this.KEYS.DOWN) {
      if (index < channels.length - 1) {
        this.setFocus('channels', channels[index + 1]);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      if (index > 0) {
        this.setFocus('channels', channels[index - 1]);
      } else if (!this.focusEpgControls()) {
        this.focusDefault('tabs');
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.LEFT) {
      // In full-screen EPG the sidebar is hidden, so stay in the guide.
      if (!document.body.classList.contains('epg-fullscreen-active')) {
        this.focusDefault('categories');
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      // Play channel stream!
      this.focusedElement.click();
      // In full-screen EPG, selecting a channel means "watch it" — drop out of the
      // guide so the now-playing player is visible.
      if (document.body.classList.contains('epg-fullscreen-active')) {
        const fullBtn = document.getElementById('epg-full-btn');
        if (fullBtn) fullBtn.click();
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT) {
      // Jump focus directly to video player (hidden in full-screen EPG, so skip).
      if (!document.body.classList.contains('epg-fullscreen-active')) {
        this.focusDefault('player');
      }
      e.preventDefault();
    }
  }

  // Focus the live EPG control buttons row; returns false if none visible.
  focusEpgControls() {
    const btn = document.querySelector('#live-view .epg-controls-header .epg-ctrl-btn');
    if (btn && btn.offsetParent !== null) { this.setFocus('channels', btn); return true; }
    return false;
  }

  handleEpgControlsNavigation(e) {
    const btns = Array.from(document.querySelectorAll('#live-view .epg-controls-header .epg-ctrl-btn'))
      .filter(b => b.offsetParent !== null);
    const idx = btns.indexOf(this.focusedElement);
    if (idx === -1) return;
    if (e.key === this.KEYS.LEFT) {
      if (idx > 0) this.setFocus('channels', btns[idx - 1]); else this.focusDefault('categories');
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT) {
      if (idx < btns.length - 1) this.setFocus('channels', btns[idx + 1]);
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      this.focusDefault('tabs');
      e.preventDefault();
    } else if (e.key === this.KEYS.DOWN) {
      this.focusDefault('channels');
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      this.focusedElement.click();
      e.preventDefault();
    }
  }

  // 4. VOD / SERIES CATALOG GRID NAVIGATION
  // Focus the catalog header's Search/Sort buttons; returns false if none.
  focusVodFilters() {
    const btn = document.querySelector('.view-panel.active .vod-filter-btn');
    if (btn) { this.setFocus('grid', btn); return true; }
    return false;
  }

  handleVodFilterNavigation(e) {
    const btns = Array.from(document.querySelectorAll('.view-panel.active .vod-filter-btn'));
    const idx = btns.indexOf(this.focusedElement);
    if (idx === -1) return;
    if (e.key === this.KEYS.LEFT) {
      if (idx > 0) this.setFocus('grid', btns[idx - 1]); else this.focusDefault('categories');
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT) {
      if (idx < btns.length - 1) this.setFocus('grid', btns[idx + 1]);
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      this.focusDefault('tabs');
      e.preventDefault();
    } else if (e.key === this.KEYS.DOWN) {
      const cw = document.querySelector('.view-panel.active .continue-row:not(.hidden) .continue-card');
      if (cw) this.setFocus('grid', cw); else this.focusDefault('grid');
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      this.focusedElement.click();
      e.preventDefault();
    }
  }

  handleGridNavigation(e) {
    // Search / Sort buttons in the catalog header (same 'grid' zone).
    if (this.focusedElement.classList.contains('vod-filter-btn')) {
      this.handleVodFilterNavigation(e);
      return;
    }

    // The Continue Watching row sits above the catalog grid. Its cards share the
    // 'grid' zone but aren't .vod-cards, so route them to a dedicated handler.
    if (this.focusedElement.classList.contains('continue-card')) {
      this.handleContinueRowNavigation(e);
      return;
    }

    const isPageBtn = this.focusedElement.classList.contains('page-btn');

    if (isPageBtn) {
      const btns = Array.from(document.querySelectorAll('.view-panel.active .vod-pagination .page-btn'));
      const index = btns.indexOf(this.focusedElement);
      if (index === -1) return;

      if (e.key === this.KEYS.LEFT) {
        if (index > 0) {
          this.setFocus('grid', btns[index - 1]);
        } else {
          this.focusDefault('categories');
        }
        e.preventDefault();
      } else if (e.key === this.KEYS.RIGHT) {
        if (index < btns.length - 1) {
          this.setFocus('grid', btns[index + 1]);
        }
        e.preventDefault();
      } else if (e.key === this.KEYS.UP) {
        // Focus the bottom row of cards
        const cards = Array.from(document.querySelectorAll('.view-panel.active .vod-grid .vod-card'));
        if (cards.length > 0) {
          this.setFocus('grid', cards[cards.length - 1]);
        } else {
          this.focusDefault('tabs');
        }
        e.preventDefault();
      } else if (e.key === this.KEYS.ENTER) {
        this.focusedElement.click();
        e.preventDefault();
      }
      return;
    }

    // Otherwise, navigate the cards grid
    const cards = Array.from(document.querySelectorAll('.view-panel.active .vod-grid .vod-card'));
    const index = cards.indexOf(this.focusedElement);
    if (index === -1) return;

    // Compute grid columns dynamically based on offset positions
    let cols = 1;
    if (cards.length > 1) {
      const firstTop = cards[0].offsetTop;
      for (let i = 1; i < cards.length; i++) {
        if (cards[i].offsetTop > firstTop) {
          cols = i;
          break;
        }
      }
    }

    if (e.key === this.KEYS.RIGHT) {
      if (index < cards.length - 1) {
        this.setFocus('grid', cards[index + 1]);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.LEFT) {
      if (index % cols !== 0) {
        this.setFocus('grid', cards[index - 1]);
      } else {
        // We are at the start of a grid row, jump back to categories sidebar list
        this.focusDefault('categories');
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.DOWN) {
      if (index + cols < cards.length) {
        this.setFocus('grid', cards[index + cols]);
      } else {
        // We are at the bottom row, navigate to page buttons
        const btns = Array.from(document.querySelectorAll('.view-panel.active .vod-pagination .page-btn'));
        if (btns.length > 0) {
          const activeBtn = btns.find(b => b.classList.contains('active')) || btns[0];
          this.setFocus('grid', activeBtn);
        }
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      if (index - cols >= 0) {
        this.setFocus('grid', cards[index - cols]);
      } else {
        // Top row: drop into the Continue Watching row if it's visible,
        // otherwise jump to the header tabs.
        const cwCards = Array.from(document.querySelectorAll('.view-panel.active .continue-row:not(.hidden) .continue-card'));
        if (cwCards.length > 0) {
          const target = this.findClosestElement(this.focusedElement, cwCards) || cwCards[0];
          this.setFocus('grid', target);
        } else if (!this.focusVodFilters()) {
          this.focusDefault('tabs');
        }
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      this.focusedElement.click(); // opens detail modal
      e.preventDefault();
    }
  }

  // 4b. CONTINUE WATCHING ROW NAVIGATION (sits above the VOD/Series grid)
  handleContinueRowNavigation(e) {
    const cards = Array.from(document.querySelectorAll('.view-panel.active .continue-row:not(.hidden) .continue-card'));
    const index = cards.indexOf(this.focusedElement);
    if (index === -1) return;

    if (e.key === this.KEYS.RIGHT) {
      if (index < cards.length - 1) this.setFocus('grid', cards[index + 1]);
      e.preventDefault();
    } else if (e.key === this.KEYS.LEFT) {
      if (index > 0) this.setFocus('grid', cards[index - 1]);
      else this.focusDefault('categories'); // off the left edge → sidebar
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      if (!this.focusVodFilters()) this.focusDefault('tabs');
      e.preventDefault();
    } else if (e.key === this.KEYS.DOWN) {
      // Drop into the first row of the catalog grid, aligned by horizontal position.
      const gridCards = Array.from(document.querySelectorAll('.view-panel.active .vod-grid .vod-card'));
      if (gridCards.length > 0) {
        const firstTop = gridCards[0].offsetTop;
        const firstRow = gridCards.filter(c => c.offsetTop === firstTop);
        const target = this.findClosestElement(this.focusedElement, firstRow) || gridCards[0];
        this.setFocus('grid', target);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      this.focusedElement.click(); // resume playback
      e.preventDefault();
    }
  }

  // 5. PLAYER FOCUS DOCK (PLAYBACK HUD VIEWPORT)
  handlePlayerNavigation(e) {
    const isFullscreen = !!document.fullscreenElement;
    const player = window.playerInstance;
    
    if (!isFullscreen || !player) {
      // NON-FULLSCREEN behavior: keep current zapping and LEFT-arrow exit
      if (e.key === this.KEYS.LEFT) {
        this.focusDefault('channels');
        e.preventDefault();
      } else if (e.key === this.KEYS.ENTER || e.key === this.KEYS.SPACE) {
        const playBtn = document.getElementById('player-play-pause-btn');
        if (playBtn) playBtn.click();
        e.preventDefault();
      } else if (e.key === this.KEYS.UP) {
        const prevBtn = document.getElementById('player-prev-btn');
        if (prevBtn) prevBtn.click();
        e.preventDefault();
      } else if (e.key === this.KEYS.DOWN) {
        const nextBtn = document.getElementById('player-next-btn');
        if (nextBtn) nextBtn.click();
        e.preventDefault();
      } else if (e.key === this.KEYS.BACKSPACE || e.key === this.KEYS.ESCAPE) {
        this.focusDefault('channels');
        e.preventDefault();
      }
      return;
    }

    // FULLSCREEN BEHAVIOR: navigable HUD controls
    // 1. Wake up controls if they are currently hidden
    const controlsVisible = player.controls && parseFloat(player.controls.style.opacity) > 0;
    
    // BACKSPACE / ESCAPE exits fullscreen immediately
    if (e.key === this.KEYS.BACKSPACE || e.key === this.KEYS.ESCAPE) {
      document.exitFullscreen().catch(() => {});
      e.preventDefault();
      return;
    }

    if (!controlsVisible) {
      // Wake up controls and don't navigate on first press
      player.showControlsTemporarily();
      // Also, set default focus to the play/pause button if nothing was focused yet
      if (!this.focusedElement || this.focusedElement.id === 'video-container') {
        const playBtn = document.getElementById('player-play-pause-btn');
        if (playBtn) this.setFocus('player', playBtn);
      }
      e.preventDefault();
      return;
    }

    // Otherwise, controls are visible. Extend visibility timeout on every D-pad interaction
    player.showControlsTemporarily();

    // Get current grid of focusable controls
    const rows = this.getPlayerRows();
    if (rows.length === 0) return;

    // Find current active element in the grid
    let currentRowIdx = -1;
    let currentColIdx = -1;
    for (let r = 0; r < rows.length; r++) {
      const colIdx = rows[r].indexOf(this.focusedElement);
      if (colIdx !== -1) {
        currentRowIdx = r;
        currentColIdx = colIdx;
        break;
      }
    }

    // If focused element is not in rows (e.g. focused on parent container), default to play/pause button
    if (currentRowIdx === -1) {
      const playBtn = document.getElementById('player-play-pause-btn') || rows[0][0];
      if (playBtn) this.setFocus('player', playBtn);
      e.preventDefault();
      return;
    }

    const currentEl = this.focusedElement;

    // Check if the current element is a range slider (seek bar or volume slider)
    const isSlider = currentEl.tagName === 'INPUT' && currentEl.type === 'range';

    if (e.key === this.KEYS.LEFT) {
      if (isSlider) {
        // Slider value adjust
        const slider = currentEl;
        const val = parseFloat(slider.value);
        const min = parseFloat(slider.min) || 0;
        const step = parseFloat(slider.step) || 1;
        const amt = currentEl.id === 'player-seek' ? 2 : 0.05; // seek 2% or change volume 5%
        slider.value = Math.max(min, val - amt);
        slider.dispatchEvent(new Event('input'));
        slider.dispatchEvent(new Event('change'));
      } else {
        // Normal horizontal navigation
        if (currentColIdx > 0) {
          this.setFocus('player', rows[currentRowIdx][currentColIdx - 1]);
        }
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT) {
      if (isSlider) {
        // Slider value adjust
        const slider = currentEl;
        const val = parseFloat(slider.value);
        const max = parseFloat(slider.max) || 100;
        const step = parseFloat(slider.step) || 1;
        const amt = currentEl.id === 'player-seek' ? 2 : 0.05; // seek 2% or change volume 5%
        slider.value = Math.min(max, val + amt);
        slider.dispatchEvent(new Event('input'));
        slider.dispatchEvent(new Event('change'));
      } else {
        // Normal horizontal navigation
        if (currentColIdx < rows[currentRowIdx].length - 1) {
          this.setFocus('player', rows[currentRowIdx][currentColIdx + 1]);
        }
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      if (currentRowIdx > 0) {
        const targetEl = this.findClosestElement(currentEl, rows[currentRowIdx - 1]);
        if (targetEl) this.setFocus('player', targetEl);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.DOWN) {
      if (currentRowIdx < rows.length - 1) {
        const targetEl = this.findClosestElement(currentEl, rows[currentRowIdx + 1]);
        if (targetEl) this.setFocus('player', targetEl);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      // For buttons, click them; for sliders, enter does nothing
      if (!isSlider) {
        currentEl.click();
      }
      e.preventDefault();
    }
  }

  // 6. SERIES EPISODES LIST NAVIGATION (TV SERIES PLAYBACK DASHBOARD)
  handleSeriesEpisodesNavigation(e) {
    const select = document.getElementById('series-season-select');
    const episodes = Array.from(document.querySelectorAll('#series-episodes-list .episode-list-row'));
    
    const focusables = [];
    if (select && select.offsetParent !== null) {
      focusables.push(select);
    }
    episodes.forEach(ep => focusables.push(ep));
    
    const index = focusables.indexOf(this.focusedElement);
    if (index === -1) {
      if (focusables.length > 0) {
        this.setFocus('series-episodes', focusables[0]);
      }
      e.preventDefault();
      return;
    }
    
    if (e.key === this.KEYS.DOWN) {
      if (index < focusables.length - 1) {
        this.setFocus('series-episodes', focusables[index + 1]);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      if (index > 0) {
        this.setFocus('series-episodes', focusables[index - 1]);
      } else {
        // Go to top navbar tabs
        this.focusDefault('tabs');
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.LEFT) {
      this.focusDefault('categories');
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT) {
      this.focusDefault('tabs');
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      if (this.focusedElement.tagName === 'SELECT') {
        // Let browser handle native select expand
        return;
      }
      this.focusedElement.click();
      e.preventDefault();
    }
  }

  // Update-available prompt: Cancel / Skip / Download.
  handleUpdateModalNavigation(e, overlay) {
    const btns = Array.from(overlay.querySelectorAll('.update-btn'));
    if (!btns.length) return;

    let idx = btns.indexOf(this.focusedElement);
    if (idx === -1) {
      // No button focused yet → focus the primary (Download / last).
      this.setFocus('update-modal', btns[btns.length - 1]);
      e.preventDefault();
      return;
    }

    if (e.key === this.KEYS.LEFT || e.key === this.KEYS.UP) {
      if (idx > 0) this.setFocus('update-modal', btns[idx - 1]);
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT || e.key === this.KEYS.DOWN) {
      if (idx < btns.length - 1) this.setFocus('update-modal', btns[idx + 1]);
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      this.focusedElement.click();
      e.preventDefault();
    } else if (e.key === this.KEYS.ESCAPE || e.key === this.KEYS.BACKSPACE) {
      const cancel = overlay.querySelector('[data-action="cancel"]');
      if (cancel) cancel.click();
      e.preventDefault();
    }
  }

  // 7. MODAL OVERLAY NAVIGATION (VOD Details / settings)
  handleModalNavigation(e, modal) {
    if (e.key === this.KEYS.BACKSPACE || e.key === this.KEYS.ESCAPE) {
      // Close active modal
      const closeBtn = modal.querySelector('.modal-close-btn');
      if (closeBtn) {
        closeBtn.click();
        
        // Return focus to catalog card or settings tab
        const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
        if (modal.id === 'vod-modal') {
          this.focusDefault('grid');
        } else {
          this.focusDefault('tabs');
        }
      }
      e.preventDefault();
      return;
    }

    if (modal.id === 'vod-modal') {
      // VOD Details modal navigation: Play button or Episodes list
      const playBtn = document.getElementById('vod-modal-play-btn');
      const dropdown = document.getElementById('seasons-dropdown');
      const episodes = Array.from(document.querySelectorAll('#episodes-list .episode-row'));
      
      const focusables = [];
      if (playBtn && !playBtn.classList.contains('hidden')) focusables.push(playBtn);
      if (dropdown && dropdown.offsetParent !== null) focusables.push(dropdown);
      episodes.forEach(ep => focusables.push(ep));

      let index = focusables.indexOf(this.focusedElement);
      
      if (index === -1) {
        // Set initial focus to play button or dropdown
        this.setFocus('modal', focusables[0]);
        e.preventDefault();
        return;
      }

      if (e.key === this.KEYS.DOWN) {
        if (index < focusables.length - 1) {
          this.setFocus('modal', focusables[index + 1]);
        }
        e.preventDefault();
      } else if (e.key === this.KEYS.UP) {
        if (index > 0) {
          this.setFocus('modal', focusables[index - 1]);
        }
        e.preventDefault();
      } else if (e.key === this.KEYS.ENTER) {
        if (this.focusedElement.tagName === 'SELECT') {
          // Let browser handle native select expand
          return;
        }
        this.focusedElement.click();
        e.preventDefault();
      }
    } else if (modal.id === 'settings-modal') {
      // Settings modal navigation
      const format = document.getElementById('settings-format');
      const proxy = document.getElementById('settings-proxy');
      const syncBtn = document.getElementById('settings-sync-now');
      const checkUpdateBtn = document.getElementById('settings-check-update');
      const logoutBtn = document.getElementById('settings-logout');

      const focusables = [format, proxy, syncBtn, checkUpdateBtn, logoutBtn].filter(Boolean);
      let index = focusables.indexOf(this.focusedElement);

      if (index === -1) {
        this.setFocus('modal', focusables[0]);
        e.preventDefault();
        return;
      }

      if (e.key === this.KEYS.DOWN) {
        if (index < focusables.length - 1) {
          this.setFocus('modal', focusables[index + 1]);
        }
        e.preventDefault();
      } else if (e.key === this.KEYS.UP) {
        if (index > 0) {
          this.setFocus('modal', focusables[index - 1]);
        }
        e.preventDefault();
      } else if (e.key === this.KEYS.ENTER) {
        if (this.focusedElement.tagName === 'SELECT') {
          // let browser handle dropdown select expansion
          return;
        }
        this.focusedElement.click();
        e.preventDefault();
      }
    }
  }

  getPlayerRows() {
    const rows = [];
    
    // Row 0: Back button
    const row0 = [];
    const back = document.getElementById('player-back-btn');
    if (back && back.offsetParent !== null) row0.push(back);
    if (row0.length > 0) rows.push(row0);
    
    // Row 1: Center controls
    const row1 = [];
    ['player-prev-btn', 'player-play-pause-btn', 'player-next-btn'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.offsetParent !== null) row1.push(el);
    });
    if (row1.length > 0) rows.push(row1);
    
    // Row 2: Seek bar
    const row2 = [];
    const seekInput = document.getElementById('player-seek');
    if (seekInput && seekInput.offsetParent !== null) row2.push(seekInput);
    if (row2.length > 0) rows.push(row2);
    
    // Row 3: Bottom icons
    const row3 = [];
    ['player-info-btn', 'player-cc-btn', 'player-volume-btn', 'player-pip-btn', 'player-fullscreen-btn'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.offsetParent !== null) row3.push(el);
    });
    if (row3.length > 0) rows.push(row3);
    
    return rows;
  }

  findClosestElement(element, targetRow) {
    if (!targetRow || targetRow.length === 0) return null;
    if (targetRow.length === 1) return targetRow[0];
    
    const rect = element.getBoundingClientRect();
    const elementCenterX = rect.left + rect.width / 2;
    
    let closest = targetRow[0];
    let minDistance = Infinity;
    
    targetRow.forEach(target => {
      const targetRect = target.getBoundingClientRect();
      const targetCenterX = targetRect.left + targetRect.width / 2;
      const distance = Math.abs(elementCenterX - targetCenterX);
      if (distance < minDistance) {
        minDistance = distance;
        closest = target;
      }
    });
    
    return closest;
  }
  handleLoginFormNavigation(e) {
    // Check which sub-screen is active
    const remoteBox = document.getElementById('remote-login-box');
    const isRemoteActive = remoteBox && remoteBox.offsetParent !== null;

    if (isRemoteActive) {
      // Remote Activation screen: Manual Login button and Download button
      const manualBtn = document.getElementById('remote-manual-login-btn');
      const backBtn = document.getElementById('login-back-btn');
      const items = [];
      if (backBtn && !backBtn.classList.contains('hidden') && backBtn.offsetParent !== null) items.push(backBtn);
      if (manualBtn && manualBtn.offsetParent !== null) items.push(manualBtn);
      const dlBtn = document.getElementById('download-app-btn');
      if (dlBtn && dlBtn.offsetParent !== null) items.push(dlBtn);

      if (e.key === this.KEYS.ENTER) {
        if (this.focusedElement) this.focusedElement.click();
        e.preventDefault();
      } else if (e.key === this.KEYS.UP || e.key === this.KEYS.LEFT) {
        const idx = items.indexOf(this.focusedElement);
        if (idx > 0) this.setFocus('login', items[idx - 1]);
        e.preventDefault();
      } else if (e.key === this.KEYS.DOWN || e.key === this.KEYS.RIGHT) {
        const idx = items.indexOf(this.focusedElement);
        if (idx < items.length - 1) this.setFocus('login', items[idx + 1]);
        e.preventDefault();
      }
      return;
    }

    // Manual login form navigation
    const manualBackBtn = document.getElementById('manual-back-btn');
    const nameEl = document.getElementById('playlist-name');
    const m3uEl = document.getElementById('m3u-url');
    const hostEl = document.getElementById('host-url');
    const userEl = document.getElementById('username');
    const passEl = document.getElementById('password');
    const loginBtn = document.getElementById('login-btn');

    // Define the grid of elements
    const grid = [];
    if (manualBackBtn && manualBackBtn.offsetParent !== null) {
      grid.push([manualBackBtn]);
    }
    if (nameEl && nameEl.offsetParent !== null) grid.push([nameEl]);
    if (m3uEl && m3uEl.offsetParent !== null) grid.push([m3uEl]);
    if (hostEl && hostEl.offsetParent !== null) grid.push([hostEl]);
    
    const row = [];
    if (userEl && userEl.offsetParent !== null) row.push(userEl);
    if (passEl && passEl.offsetParent !== null) row.push(passEl);
    if (row.length > 0) grid.push(row);

    if (loginBtn && loginBtn.offsetParent !== null) grid.push([loginBtn]);
    const dlBtn = document.getElementById('download-app-btn');
    if (dlBtn && dlBtn.offsetParent !== null) grid.push([dlBtn]);

    // Find current position in grid
    let r = -1;
    let c = -1;
    for (let i = 0; i < grid.length; i++) {
      const colIdx = grid[i].indexOf(this.focusedElement);
      if (colIdx !== -1) {
        r = i;
        c = colIdx;
        break;
      }
    }

    if (r === -1) {
      // Fallback
      const defaultFocus = document.getElementById('m3u-url') || document.getElementById('playlist-name');
      if (defaultFocus) this.setFocus('login', defaultFocus);
      return;
    }

    if (e.key === this.KEYS.DOWN) {
      if (r < grid.length - 1) {
        const nextRow = grid[r + 1];
        const nextColIdx = Math.min(c, nextRow.length - 1);
        this.setFocus('login', nextRow[nextColIdx]);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      if (r > 0) {
        const prevRow = grid[r - 1];
        const prevColIdx = Math.min(c, prevRow.length - 1);
        this.setFocus('login', prevRow[prevColIdx]);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.LEFT) {
      if (grid[r].length > 1 && c > 0) {
        this.setFocus('login', grid[r][c - 1]);
        e.preventDefault();
      }
    } else if (e.key === this.KEYS.RIGHT) {
      if (grid[r].length > 1 && c < grid[r].length - 1) {
        this.setFocus('login', grid[r][c + 1]);
        e.preventDefault();
      }
    } else if (e.key === this.KEYS.ENTER) {
      if (this.focusedElement.tagName === 'INPUT') {
        this.focusedElement.focus();
      } else {
        this.focusedElement.click();
      }
      e.preventDefault();
    }
  }

  handlePlaylistSelectNavigation(e) {
    const backBtn = document.getElementById('login-back-btn');
    const rows = Array.from(document.querySelectorAll('#login-playlists-list .playlist-row'));
    const addBtn = document.getElementById('login-show-form-btn');

    // Create a flat list of focusable ROWS (not delete buttons)
    const items = [];
    if (backBtn && !backBtn.classList.contains('hidden') && backBtn.offsetParent !== null) {
      items.push(backBtn);
    }
    items.push(...rows);
    if (addBtn && addBtn.offsetParent !== null) {
      items.push(addBtn);
    }
    const dlBtn = document.getElementById('download-app-btn');
    if (dlBtn && dlBtn.offsetParent !== null) {
      items.push(dlBtn);
    }

    // Get current row (if on delete button, get parent row)
    const isDelBtn = this.focusedElement && this.focusedElement.classList.contains('playlist-row-del');
    let currentRow = isDelBtn ? this.focusedElement.closest('.playlist-row') : this.focusedElement;
    const index = items.indexOf(currentRow);

    console.log('handlePlaylistSelectNavigation:', { isDelBtn, currentIndex: index, key: e.key, focused: this.focusedElement?.className });

    if (index === -1 && items[0]) {
      console.log('Focus lost, resetting to first item');
      this.setFocus('playlist-select', items[0]);
      return;
    }

    // Vertical navigation (UP/DOWN) - move between rows
    if (e.key === this.KEYS.DOWN) {
      if (index < items.length - 1) {
        const nextItem = items[index + 1];
        // If on delete button, stay on the button of next row. Otherwise move to next row
        if (isDelBtn) {
          const delBtn = nextItem.classList.contains('playlist-row') ? nextItem.querySelector('.playlist-row-del') : null;
          this.setFocus('playlist-select', delBtn || nextItem);
        } else {
          this.setFocus('playlist-select', nextItem);
        }
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      if (index > 0) {
        const prevItem = items[index - 1];
        // If on delete button, stay on the button of prev row. Otherwise move to prev row
        if (isDelBtn) {
          const delBtn = prevItem.classList.contains('playlist-row') ? prevItem.querySelector('.playlist-row-del') : null;
          this.setFocus('playlist-select', delBtn || prevItem);
        } else {
          this.setFocus('playlist-select', prevItem);
        }
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT) {
      // Right arrow: move from row to its delete button
      if (!isDelBtn && currentRow && currentRow.classList.contains('playlist-row')) {
        const delBtn = currentRow.querySelector('.playlist-row-del');
        if (delBtn) {
          this.setFocus('playlist-select', delBtn);
        }
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.LEFT) {
      // Left arrow: move from delete button back to row
      if (isDelBtn && currentRow) {
        this.setFocus('playlist-select', currentRow);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      console.log('Playlist-select ENTER pressed on:', this.focusedElement?.className, this.focusedElement?.dataset?.playlistName);
      this.focusedElement.click();
      e.preventDefault();
    }
  }

  handlePlaylistDropdownNavigation(e) {
    const rows = Array.from(document.querySelectorAll('#playlist-dropdown-list .playlist-row'));
    const addBtn = document.getElementById('playlist-add-btn');

    // Create a flat list of focusable rows/buttons
    const items = [...rows];
    if (addBtn && addBtn.offsetParent !== null) {
      items.push(addBtn);
    }

    // Find if focused element is a delete button
    const isDelBtn = this.focusedElement && this.focusedElement.classList.contains('playlist-row-del');
    let activeRow = null;
    if (isDelBtn) {
      activeRow = this.focusedElement.closest('.playlist-row');
    }

    const index = items.indexOf(isDelBtn ? activeRow : this.focusedElement);

    if (index === -1) {
      if (items[0]) this.setFocus('playlist-dropdown', items[0]);
      return;
    }

    if (e.key === this.KEYS.DOWN) {
      if (index < items.length - 1) {
        const nextItem = items[index + 1];
        if (isDelBtn && nextItem.classList.contains('playlist-row')) {
          const delBtn = nextItem.querySelector('.playlist-row-del');
          this.setFocus('playlist-dropdown', delBtn || nextItem);
        } else {
          this.setFocus('playlist-dropdown', nextItem);
        }
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      if (index > 0) {
        const prevItem = items[index - 1];
        if (isDelBtn && prevItem.classList.contains('playlist-row')) {
          const delBtn = prevItem.querySelector('.playlist-row-del');
          this.setFocus('playlist-dropdown', delBtn || prevItem);
        } else {
          this.setFocus('playlist-dropdown', prevItem);
        }
      } else {
        // Close dropdown and focus profile button
        const dd = document.getElementById('playlist-dropdown');
        if (dd) dd.classList.add('hidden');
        const profileBtn = document.getElementById('profile-card-btn');
        if (profileBtn) {
          this.setFocus('tabs', profileBtn);
        }
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT) {
      if (!isDelBtn && this.focusedElement.classList.contains('playlist-row')) {
        const delBtn = this.focusedElement.querySelector('.playlist-row-del');
        if (delBtn) {
          this.setFocus('playlist-dropdown', delBtn);
        }
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.LEFT) {
      if (isDelBtn && activeRow) {
        this.setFocus('playlist-dropdown', activeRow);
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      this.focusedElement.click();
      e.preventDefault();
    } else if (e.key === this.KEYS.ESCAPE || e.key === this.KEYS.BACKSPACE) {
      // Close dropdown and focus profile button
      const dd = document.getElementById('playlist-dropdown');
      if (dd) dd.classList.add('hidden');
      const profileBtn = document.getElementById('profile-card-btn');
      if (profileBtn) {
        this.setFocus('tabs', profileBtn);
      }
      e.preventDefault();
    }
  }
}

// Export singleton instance
export const navigation = new TVNavigation();
export default navigation;
