import { getEPG } from './xtream-api.js';
import { navigation } from './tv-navigation.js';

export class EPGGrid {
  constructor(onChannelSelectCallback) {
    this.onChannelSelect = onChannelSelectCallback;
    
    // UI elements
    this.hoursSelect = document.getElementById('epg-hours-range');
    this.timelineHours = document.getElementById('epg-timeline-hours');
    this.channelsList = document.getElementById('epg-channels-list');
    this.gridViewport = document.getElementById('epg-grid-viewport');
    this.programsRows = document.getElementById('epg-programs-rows');
    this.timeIndicator = document.getElementById('epg-current-time-indicator');
    this.gridLines = document.getElementById('epg-grid-lines');
    this.dateLabel = document.getElementById('epg-selected-date-label');
    this.visibleCount = document.getElementById('epg-visible-count');

    this.navPrev = document.getElementById('epg-nav-prev');
    this.navNow = document.getElementById('epg-nav-now');
    this.navNext = document.getElementById('epg-nav-next');
    this.channelsFilter = document.getElementById('epg-channels-filter');
    this.refreshBtn = document.getElementById('epg-refresh-btn');
    this.fullBtn = document.getElementById('epg-full-btn');
    this.toggleTimelineBtn = document.getElementById('epg-toggle-timeline-btn');

    // Layout configuration
    this.pxPerHour = 300; // Width of 1 hour in pixels
    this.rowHeight = 64;  // Height of 1 channel row in pixels
    this.windowOffsetHours = 2; // Hours to show in the past
    
    this.channels = [];
    this.epgData = {}; // Cache map: stream_id -> epg_listings
    this.selectedDate = new Date();
    this.timeOffsetMs = 0; // Sliding navigation offset in ms
    
    this.initEventListeners();
  }

  initEventListeners() {
    // Sync scrolling vertically in both directions with lock flags to prevent scroll loops
    let isScrollingViewport = false;
    let isScrollingChannels = false;

    this.gridViewport.addEventListener('scroll', () => {
      if (isScrollingChannels) {
        isScrollingChannels = false;
        return;
      }
      isScrollingViewport = true;
      this.channelsList.scrollTop = this.gridViewport.scrollTop;
    });

    this.channelsList.addEventListener('scroll', () => {
      if (isScrollingViewport) {
        isScrollingViewport = false;
        return;
      }
      isScrollingChannels = true;
      this.gridViewport.scrollTop = this.channelsList.scrollTop;
    });

    // Toggle expandable/collapsible channel column on mobile when header cell is clicked
    const channelHeaderCell = document.querySelector('.epg-channel-header-cell');
    if (channelHeaderCell) {
      channelHeaderCell.addEventListener('click', () => {
        const gridLayout = document.querySelector('.epg-grid-layout');
        if (gridLayout) {
          gridLayout.classList.toggle('epg-channel-col-expanded');
        }
      });
    }

    // Hours range change
    this.hoursSelect.addEventListener('change', () => {
      this.render();
    });

    // Navigation buttons
    this.navNow.addEventListener('click', () => {
      this.timeOffsetMs = 0;
      this.selectedDate = new Date();
      this.navNow.classList.add('active');
      this.render();
      this.scrollToCurrentTime();
    });

    this.navPrev.addEventListener('click', () => {
      const hours = parseInt(this.hoursSelect.value);
      this.timeOffsetMs -= (hours - 1) * 60 * 60 * 1000;
      this.navNow.classList.remove('active');
      this.render();
    });

    this.navNext.addEventListener('click', () => {
      const hours = parseInt(this.hoursSelect.value);
      this.timeOffsetMs += (hours - 1) * 60 * 60 * 1000;
      this.navNow.classList.remove('active');
      this.render();
    });

    // Channel filtering
    let filterTimeout;
    this.channelsFilter.addEventListener('input', (e) => {
      clearTimeout(filterTimeout);
      filterTimeout = setTimeout(() => {
        this.renderChannelsAndGrid(e.target.value);
      }, 300);
    });

    // Refresh EPG data
    this.refreshBtn.addEventListener('click', () => {
      this.epgData = {};
      this.loadEPGForVisibleChannels(true);
    });

    // Full screen EPG toggle
    if (this.fullBtn) {
      this.fullBtn.addEventListener('click', () => this.toggleFullscreen());
    }

    // EPG Timeline Toggle
    if (this.toggleTimelineBtn) {
      this.toggleTimelineBtn.addEventListener('click', () => {
        const epgContainer = document.querySelector('.epg-section-container');
        if (epgContainer) {
          const isHidden = epgContainer.classList.toggle('timeline-hidden');
          this.toggleTimelineBtn.innerHTML = isHidden
            ? '<i data-lucide="calendar"></i> Show Guide'
            : '<i data-lucide="calendar-off"></i> Hide Guide';
          lucide.createIcons({ scope: this.toggleTimelineBtn });
          
          if (!isHidden) {
            this.render();
            this.scrollToCurrentTime();
          }
        }
      });
    }
  }

  // Expand the EPG guide to fill the screen (hides header / sidebar / player).
  // Keeps the channel list remote- and keyboard-navigable via the 'channels' zone.
  setFullscreen(on) {
    document.body.classList.toggle('epg-fullscreen-active', on);

    if (this.fullBtn) {
      this.fullBtn.classList.toggle('active', on);
      this.fullBtn.innerHTML = on
        ? '<i data-lucide="minimize"></i> Exit full screen'
        : '<i data-lucide="expand"></i> Full screen EPG';
      lucide.createIcons({ scope: this.fullBtn });
    }

    // Re-layout for the new viewport size.
    this.render();
    this.scrollToCurrentTime();

    if (on) {
      const target = this.channelsList.querySelector('.epg-channel-row.active')
        || this.channelsList.querySelector('.epg-channel-row');
      if (target) navigation.setFocus('channels', target);
    }
  }

  toggleFullscreen() {
    this.setFullscreen(!document.body.classList.contains('epg-fullscreen-active'));
  }

  setChannels(channels) {
    this.channels = channels;
    this.timeOffsetMs = 0;
    this.selectedDate = new Date();
    this.navNow.classList.add('active');
    this.render();
    this.scrollToCurrentTime();
    if (navigation.currentZone === 'channels') {
      navigation.focusDefault('channels');
    }
  }

  // Calculate times based on now + navigation offsets
  getGuideTimeWindow() {
    const hoursToShow = parseInt(this.hoursSelect.value);
    
    // Base time: current time + user pagination offset
    const baseTime = new Date(Date.now() + this.timeOffsetMs);
    
    // Guide starts X hours in the past
    const startTime = new Date(baseTime.getTime() - this.windowOffsetHours * 60 * 60 * 1000);
    
    // Round start time down to the nearest 30 mins for a clean timeline grid
    const minutes = startTime.getMinutes();
    const roundMinutes = minutes >= 30 ? 30 : 0;
    startTime.setMinutes(roundMinutes, 0, 0);

    const endTime = new Date(startTime.getTime() + hoursToShow * 60 * 60 * 1000);

    return { startTime, endTime, hoursToShow };
  }

  render() {
    if (!this.channels || this.channels.length === 0) {
      this.channelsList.innerHTML = '<div class="epg-no-channels">No channels</div>';
      this.programsRows.innerHTML = '';
      this.timelineHours.innerHTML = '';
      this.visibleCount.textContent = '(0)';
      return;
    }

    const { startTime, endTime, hoursToShow } = this.getGuideTimeWindow();
    
    // Render EPG date label
    const options = { weekday: 'long', month: 'short', day: 'numeric' };
    this.dateLabel.textContent = startTime.toLocaleDateString('en-US', options);

    // 1. Render timeline header ticks
    this.renderTimelineHeader(startTime, hoursToShow);

    // 2. Render channels list and corresponding guide rows
    this.renderChannelsAndGrid(this.channelsFilter.value);

    // 3. Update current time red line indicator
    this.updateCurrentTimeIndicator(startTime, endTime);
  }

  renderTimelineHeader(startTime, hoursToShow) {
    this.timelineHours.innerHTML = '';
    const totalWidth = hoursToShow * this.pxPerHour;
    this.timelineHours.style.width = `${totalWidth}px`;
    this.programsRows.style.width = `${totalWidth}px`;
    this.gridLines.style.width = `${totalWidth}px`;

    // Draw grid vertical hour lines
    this.gridLines.innerHTML = '';

    for (let i = 0; i < hoursToShow; i++) {
      const tickTime = new Date(startTime.getTime() + i * 60 * 60 * 1000);
      const leftPos = i * this.pxPerHour;

      // Hour label
      const tick = document.createElement('div');
      tick.className = 'epg-hour-tick';
      tick.style.left = `${leftPos}px`;
      tick.style.width = `${this.pxPerHour}px`;
      
      const hourStr = tickTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      tick.textContent = hourStr;
      this.timelineHours.appendChild(tick);

      // Vertical grid line
      const gridLine = document.createElement('div');
      gridLine.style.position = 'absolute';
      gridLine.style.left = `${leftPos}px`;
      gridLine.style.top = '0';
      gridLine.style.bottom = '0';
      gridLine.style.borderLeft = '1px solid rgba(255, 255, 255, 0.05)';
      this.gridLines.appendChild(gridLine);
    }
  }

  renderChannelsAndGrid(filterKeyword = '') {
    const { startTime, endTime } = this.getGuideTimeWindow();
    const pxPerMs = this.pxPerHour / (60 * 60 * 1000);

    const query = filterKeyword.toLowerCase();
    const filtered = this.channels.filter(c => (c.name || '').toLowerCase().includes(query));
    
    this.visibleCount.textContent = `(${filtered.length})`;

    this.channelsList.innerHTML = '';
    this.programsRows.innerHTML = '';

    filtered.forEach((channel) => {
      const streamId = String(channel.stream_id);

      // --- 1. Channel Left Item ---
      const chanRow = document.createElement('div');
      chanRow.className = 'epg-channel-row';
      chanRow.dataset.streamId = streamId;
      
      const logo = channel.stream_icon || '';
      chanRow.innerHTML = `
        <div class="epg-channel-row-logo">
          ${logo ? `<img src="${logo}" alt="" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%234b5563%22 stroke-width=%222%22><rect x=%222%22 y=%222%22 width=%2220%22 height=%2220%22 rx=%224%22/></svg>'">` : '<i data-lucide="tv" class="fallback-logo"></i>'}
        </div>
        <div class="epg-channel-row-meta">
          <div class="epg-channel-row-name">${channel.name}</div>
        </div>
        <button class="epg-channel-row-fav" data-id="${streamId}">
          <i data-lucide="star"></i>
        </button>
      `;

      // Active highlighting
      chanRow.addEventListener('click', (e) => {
        if (e.target.closest('.epg-channel-row-fav')) return; // ignore fav click

        document.querySelectorAll('.epg-channel-row').forEach(r => r.classList.remove('active'));
        chanRow.classList.add('active');

        // Sync EPG Channel Focus
        navigation.setFocus('channels', chanRow);

        // Select matching program block
        const activeBlock = this.getCurrentProgramBlock(streamId, startTime, endTime);
        this.onChannelSelect(channel, activeBlock);

        // A real pointer click while in the full-screen guide means "watch this"
        // — leave full screen so the now-playing video is visible. (Synthetic
        // clicks from keyboard/remote navigation have isTrusted === false and are
        // ignored here; that exit is handled in the navigation layer instead.)
        if (e.isTrusted && document.body.classList.contains('epg-fullscreen-active')) {
          this.setFullscreen(false);
        }
      });

      // Favorite toggle click handler
      const favBtn = chanRow.querySelector('.epg-channel-row-fav');
      if (favBtn) {
        favBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (window.toggleChannelFavorite) {
            window.toggleChannelFavorite('live', streamId);
          }
        });
      }

      this.channelsList.appendChild(chanRow);

      // --- 2. Programs Right Row ---
      const progRow = document.createElement('div');
      progRow.className = 'epg-programs-row';
      progRow.dataset.streamId = streamId;

      // Check if we have listings cached
      const listings = this.epgData[streamId] || [];
      const windowStart = startTime.getTime();
      const windowEnd = endTime.getTime();

      if (listings.length === 0) {
        // Draw standard "No information available" block spanning whole timeline
        const placeholderBlock = this.createProgramBlock(
          'No information available',
          windowStart,
          windowEnd,
          startTime,
          pxPerMs
        );
        placeholderBlock.addEventListener('click', () => {
          chanRow.click();
        });
        progRow.appendChild(placeholderBlock);
      } else {
        // Draw actual blocks
        listings.forEach(prog => {
          const startMs = parseInt(prog.start_timestamp) * 1000;
          const endMs = parseInt(prog.end_timestamp) * 1000;

          // Out of window check
          if (endMs <= windowStart || startMs >= windowEnd) return;

          const blockStart = Math.max(startMs, windowStart);
          const blockEnd = Math.min(endMs, windowEnd);

          const block = this.createProgramBlock(
            prog.title || 'No Title',
            blockStart,
            blockEnd,
            startTime,
            pxPerMs,
            prog
          );

          // Click handler
          block.addEventListener('click', () => {
            chanRow.click(); // clicks channel row
            this.onChannelSelect(channel, prog); // sends actual clicked program
          });

          progRow.appendChild(block);
        });
      }

      this.programsRows.appendChild(progRow);
    });

    // Re-trigger icon updates (specifically stars on favorite icons)
    lucide.createIcons({ scope: this.channelsList });
    this.updateFavoritesHighlighting();

    // Trigger on-demand EPG fetch for visible channels in background
    this.loadEPGForVisibleChannels();
  }

  createProgramBlock(title, startMs, endMs, startTime, pxPerMs, progData = null) {
    const left = (startMs - startTime.getTime()) * pxPerMs;
    const width = (endMs - startMs) * pxPerMs;

    const block = document.createElement('div');
    block.className = 'epg-program-block';
    block.style.left = `${left}px`;
    block.style.width = `${width}px`;
    
    // Check if currently playing
    const now = Date.now();
    if (progData && now >= (progData.start_timestamp * 1000) && now <= (progData.end_timestamp * 1000)) {
      block.classList.add('active');
    }

    const startStr = new Date(startMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const endStr = new Date(endMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    block.innerHTML = `
      <span class="epg-program-title">${title}</span>
      <span class="epg-program-time">${startStr} - ${endStr}</span>
    `;

    // Tooltip details on hover
    block.title = `${title} (${startStr} - ${endStr})`;

    return block;
  }

  getCurrentProgramBlock(streamId, startTime, endTime) {
    const listings = this.epgData[streamId] || [];
    const now = Date.now();

    const current = listings.find(p => {
      const s = parseInt(p.start_timestamp) * 1000;
      const e = parseInt(p.end_timestamp) * 1000;
      return now >= s && now <= e;
    });

    if (current) return current;

    // Fallback: Return placeholder info
    return {
      title: 'No information available',
      start_timestamp: String(Math.floor(startTime.getTime() / 1000)),
      end_timestamp: String(Math.floor(endTime.getTime() / 1000)),
      description: 'No program details available.'
    };
  }

  updateCurrentTimeIndicator(startTime, endTime) {
    const pxPerMs = this.pxPerHour / (60 * 60 * 1000);
    const now = Date.now();

    if (now >= startTime.getTime() && now <= endTime.getTime()) {
      const left = (now - startTime.getTime()) * pxPerMs;
      this.timeIndicator.style.left = `${left}px`;
      this.timeIndicator.style.display = 'block';
    } else {
      this.timeIndicator.style.display = 'none';
    }
  }

  scrollToCurrentTime() {
    const { startTime } = this.getGuideTimeWindow();
    const pxPerMs = this.pxPerHour / (60 * 60 * 1000);
    const now = Date.now();

    const currentOffsetMs = now - startTime.getTime();
    if (currentOffsetMs > 0) {
      const scrollPos = currentOffsetMs * pxPerMs - 200; // Center or offset by 200px
      this.gridViewport.scrollLeft = Math.max(0, scrollPos);
    }
  }

  // Load short EPG dynamically for the visible channels in viewport
  async loadEPGForVisibleChannels(force = false) {
    // Collect stream IDs that don't have cached data
    const streamIds = [];
    document.querySelectorAll('.epg-channel-row').forEach(row => {
      const id = row.dataset.streamId;
      if (id && (force || !this.epgData[id])) {
        streamIds.push(id);
      }
    });

    if (streamIds.length === 0) return;

    // Chunk requests to prevent server lockups
    const chunkSize = 5;
    for (let i = 0; i < streamIds.length; i += chunkSize) {
      const chunk = streamIds.slice(i, i + chunkSize);
      
      // Fetch in parallel
      await Promise.all(chunk.map(async (id) => {
        try {
          const data = await getEPG(id);
          this.epgData[id] = data.listings || [];
          
          // Re-render specifically that channel's row if listings are found
          if (data.listings && data.listings.length > 0) {
            this.updateChannelProgramRow(id);
          }
        } catch (err) {
          console.warn(`EPG fetch failed for channel ${id}:`, err);
        }
      }));
    }
  }

  // Hot replace a specific channel row in the DOM after EPG is fetched
  updateChannelProgramRow(streamId) {
    const progRow = document.querySelector(`.epg-programs-row[data-stream-id="${streamId}"]`);
    if (!progRow) return;

    const { startTime, endTime } = this.getGuideTimeWindow();
    const pxPerMs = this.pxPerHour / (60 * 60 * 1000);
    const listings = this.epgData[streamId] || [];
    const windowStart = startTime.getTime();
    const windowEnd = endTime.getTime();

    if (listings.length === 0) return;

    progRow.innerHTML = '';
    
    // Find corresponding channel row for trigger mapping
    const chanRow = document.querySelector(`.epg-channel-row[data-stream-id="${streamId}"]`);
    const channel = this.channels.find(c => String(c.stream_id) === String(streamId));

    listings.forEach(prog => {
      const startMs = parseInt(prog.start_timestamp) * 1000;
      const endMs = parseInt(prog.end_timestamp) * 1000;

      if (endMs <= windowStart || startMs >= windowEnd) return;

      const blockStart = Math.max(startMs, windowStart);
      const blockEnd = Math.min(endMs, windowEnd);

      const block = this.createProgramBlock(
        prog.title || 'No Title',
        blockStart,
        blockEnd,
        startTime,
        pxPerMs,
        prog
      );

      block.addEventListener('click', () => {
        if (chanRow) chanRow.click();
        this.onChannelSelect(channel, prog);
      });

      progRow.appendChild(block);
    });
  }

  // Update favorites highlighting in EPG list
  updateFavoritesHighlighting() {
    // Check favorites by requesting from main app favorites list cache
    // Let's hook into a global favorites checker which will be populated
    document.querySelectorAll('.epg-channel-row-fav').forEach(btn => {
      const id = btn.dataset.id;
      const isFav = window.isChannelFavorite?.('live', id) || false;
      if (isFav) {
        btn.classList.add('favorited');
        btn.innerHTML = '<i class="star-filled" data-lucide="star"></i>';
      } else {
        btn.classList.remove('favorited');
        btn.innerHTML = '<i data-lucide="star"></i>';
      }
    });
    lucide.createIcons({ scope: this.channelsList });
  }
}
export default EPGGrid;
