/**
 * TV Navigation Coordinator for Arrow Key & Enter Button Navigation.
 * Enables full remote control (keyboard equivalent) usage.
 */

class TVNavigation {
  constructor() {
    this.currentZone = 'categories'; // 'tabs', 'categories', 'channels', 'grid', 'player', 'modal'
    this.focusedElement = null;
    
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

    // Scroll into view if scrollable
    this.focusedElement.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest'
    });

    console.log(`TV Focus -> Zone: ${zone}, Element:`, element.textContent?.trim() || element.className);
  }

  // Remove focus entirely
  clearFocus() {
    if (this.focusedElement) {
      this.focusedElement.classList.remove('tv-focused');
      this.focusedElement = null;
    }
  }

  // Automatically focus the default element when views switch
  focusDefault(zone) {
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
      // VOD Grid
      const firstCard = document.querySelector('.vod-card');
      if (firstCard) {
        this.setFocus('grid', firstCard);
        return;
      }
    } else if (zone === 'player') {
      const player = document.getElementById('video-container');
      if (player) {
        this.setFocus('player', player);
        return;
      }
    }
    
    this.clearFocus();
  }

  handleKeyDown(e) {
    // Ignore TV navigation if user is in login screen or typing in search boxes
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT' || activeEl.tagName === 'TEXTAREA')) {
      if (e.key === this.KEYS.ENTER && activeEl.id === 'categories-search') {
        activeEl.blur(); // blur search box on enter
        this.focusDefault('categories');
        e.preventDefault();
      }
      return; // let standard text input fields consume arrow keys/text keys
    }

    // Modal check (VOD or Settings overlay)
    const activeModal = document.querySelector('.modal-overlay:not(.hidden)');
    if (activeModal) {
      this.handleModalNavigation(e, activeModal);
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
    const items = Array.from(document.querySelectorAll('#categories-list .category-item:not(.hidden)'));
    const pinItems = Array.from(document.querySelectorAll('.pin-item'));
    const allItems = [...pinItems, ...items];
    
    const index = allItems.indexOf(this.focusedElement);
    if (index === -1) return;

    if (e.key === this.KEYS.DOWN) {
      if (index < allItems.length - 1) {
        this.setFocus('categories', allItems[index + 1]);
        // Trigger click on hover to load streams dynamically
        allItems[index + 1].click();
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      if (index > 0) {
        this.setFocus('categories', allItems[index - 1]);
        allItems[index - 1].click();
      } else {
        // Focus top navbar tabs
        this.focusDefault('tabs');
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT || e.key === this.KEYS.ENTER) {
      // Select category and jump to EPG Channels list or VOD Grid
      this.focusedElement.click();
      
      const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
      if (activeTab === 'live') {
        this.focusDefault('channels');
      } else {
        this.focusDefault('grid');
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
        // Auto-select program description details
        channels[index + 1].click();
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      if (index > 0) {
        this.setFocus('channels', channels[index - 1]);
        channels[index - 1].click();
      } else {
        this.focusDefault('tabs');
      }
      e.preventDefault();
    } else if (e.key === this.KEYS.LEFT) {
      // Jump back to categories sidebar list
      this.focusDefault('categories');
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER) {
      // Play channel stream!
      this.focusedElement.click();
      e.preventDefault();
    } else if (e.key === this.KEYS.RIGHT) {
      // Jump focus directly to video player
      this.focusDefault('player');
      e.preventDefault();
    }
  }

  // 4. VOD / SERIES CATALOG GRID NAVIGATION
  handleGridNavigation(e) {
    const cards = Array.from(document.querySelectorAll('.vod-grid .vod-card'));
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
    if (e.key === this.KEYS.LEFT) {
      // Move focus back to the EPG list
      this.focusDefault('channels');
      e.preventDefault();
    } else if (e.key === this.KEYS.ENTER || e.key === this.KEYS.SPACE) {
      // Play / Pause toggle
      const playBtn = document.getElementById('player-play-pause-btn');
      if (playBtn) playBtn.click();
      e.preventDefault();
    } else if (e.key === this.KEYS.UP) {
      // Zap up: previous channel
      const prevBtn = document.getElementById('player-prev-btn');
      if (prevBtn) prevBtn.click();
      e.preventDefault();
    } else if (e.key === this.KEYS.DOWN) {
      // Zap down: next channel
      const nextBtn = document.getElementById('player-next-btn');
      if (nextBtn) nextBtn.click();
      e.preventDefault();
    } else if (e.key === this.KEYS.BACKSPACE || e.key === this.KEYS.ESCAPE) {
      // Exit player focus and go back to channels
      this.focusDefault('channels');
      // If player is fullscreen, exit it
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
      e.preventDefault();
    }
  }

  // 6. MODAL OVERLAY NAVIGATION (VOD Details / settings)
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
        } else {
          this.focusedElement.click();
          e.preventDefault();
        }
      }
    }
  }
}

// Export singleton instance
export const navigation = new TVNavigation();
export default navigation;
