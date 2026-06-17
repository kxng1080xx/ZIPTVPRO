import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

/**
 * TV Navigation Coordinator for Arrow Key & Enter Button Navigation.
 * Enables full remote control (keyboard equivalent) usage.
 */

class TVNavigation {
  constructor() {
    this.currentZone = 'categories'; // 'tabs', 'categories', 'channels', 'grid', 'player', 'modal'
    this.focusedElement = null;
    this.pendingZone = null;
    
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
      App.addListener('backButton', () => {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(err => console.warn(err));
          this.focusDefault('channels');
        } else {
          if (document.body.classList.contains('epg-fullscreen-active')) {
            const fullBtn = document.getElementById('epg-full-btn');
            if (fullBtn) fullBtn.click();
          } else {
            App.exitApp();
          }
        }
      });
    }
  }

  // Set focus to a specific element within a zone
  setFocus(zone, element) {
    if (!element) return;

    // Remove focus class from previous element
    if (this.focusedElement) {
      this.focusedElement.classList.remove('tv-focused');
    }

    this.currentZone = zone;
    this.focusedElement = element;
    this.focusedElement.classList.add('tv-focused');
    
    // Clear pending zone on successful focus
    this.pendingZone = null;

    // Scroll into view if scrollable (use 'auto' / instant to prevent queueing animations and layout freezes on Smart TVs)
    this.focusedElement.scrollIntoView({
      behavior: 'auto',
      block: 'nearest',
      inline: 'nearest'
    });

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
    }
    
    this.clearFocus();
  }

  handleKeyDown(e) {
    // If the video player is in fullscreen, pressing Backspace or Escape exits fullscreen
    if (document.fullscreenElement && (e.key === this.KEYS.ESCAPE || e.key === this.KEYS.BACKSPACE)) {
      document.exitFullscreen().catch(err => console.warn(err));
      e.preventDefault();
      return;
    }

    // Ignore TV navigation if user is typing in search boxes
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
      if (e.key === this.KEYS.ENTER && activeEl.id === 'categories-search') {
        activeEl.blur(); // blur search box on enter
        this.focusDefault('categories');
        e.preventDefault();
      }
      return; // let standard text input fields consume arrow keys/text keys
    }

    // Recovery: if focused element is null or detached from DOM, restore default focus for current zone
    if (!this.focusedElement || !document.body.contains(this.focusedElement)) {
      console.warn(`TV Focus lost or detached from DOM (zone: ${this.currentZone}). Recovering...`);
      this.focusDefault(this.currentZone);
    }

    // Modal check (VOD or Settings overlay)
    const activeModal = document.querySelector('.modal-overlay:not(.hidden)');
    if (activeModal) {
      this.handleModalNavigation(e, activeModal);
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
      default:
        // Default recovery
        this.focusDefault('categories');
        break;
    }
  }

  // 1. TABS HEADER NAVIGATION
  handleTabsNavigation(e) {
    const tabs = Array.from(document.querySelectorAll('.nav-tab'));
    const index = tabs.indexOf(this.focusedElement);
    if (index === -1) return;

    if (e.key === this.KEYS.LEFT) {
      if (index > 0) {
        this.setFocus('tabs', tabs[index - 1]);
        tabs[index - 1].click(); // click/change tab immediately
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT) {
      if (index < tabs.length - 1) {
        this.setFocus('tabs', tabs[index + 1]);
        tabs[index + 1].click();
      } else {
        // Move to Settings button
        const settings = document.getElementById('settings-btn');
        if (settings) this.setFocus('tabs', settings);
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
    
    // Settings focus override
    if (this.focusedElement.id === 'settings-btn') {
      if (e.key === this.KEYS.LEFT) {
        this.setFocus('tabs', tabs[tabs.length - 1]);
        e.preventDefault();
      } else if (e.key === this.KEYS.ENTER) {
        this.focusedElement.click();
        e.preventDefault();
      } else if (e.key === this.KEYS.DOWN) {
        this.focusDefault('categories');
        e.preventDefault();
      }
    }
  }

  // 2. CATEGORIES SIDEBAR NAVIGATION
  handleCategoriesNavigation(e) {
    const pinToggle = document.getElementById('pin-section-toggle');
    const searchInput = document.getElementById('categories-search');
    const items = Array.from(document.querySelectorAll('#categories-list .category-item:not(.hidden)'));
    const pinItems = Array.from(document.querySelectorAll('.pin-item'));

    // Top-to-bottom focus order: the "Pin top section" header, the pinned items
    // (only when the section is expanded/visible), the search box, then categories.
    const allItems = [];
    if (pinToggle) allItems.push(pinToggle);
    pinItems.forEach(p => { if (p.offsetParent !== null) allItems.push(p); });
    if (searchInput && searchInput.offsetParent !== null) allItems.push(searchInput);
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
      } else if (this.focusedElement.id === 'categories-search') {
        if (e.key === this.KEYS.ENTER) {
          this.focusedElement.focus(); // Focus natively to open virtual keyboard
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
      } else {
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

  // 4. VOD / SERIES CATALOG GRID NAVIGATION
  handleGridNavigation(e) {
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
        // Focus header tabs
        this.focusDefault('tabs');
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      this.focusedElement.click(); // opens detail modal
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
      const logoutBtn = document.getElementById('settings-logout');
      
      const focusables = [format, proxy, syncBtn, logoutBtn];
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
}

// Export singleton instance
export const navigation = new TVNavigation();
export default navigation;
