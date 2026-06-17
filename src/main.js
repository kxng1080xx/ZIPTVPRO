import {
  getStatus,
  login,
  logout,
  updateSettings,
  syncPlaylist,
  getCategories,
  getStreams,
  toggleFavorite,
  trackPlayback,
  getStreamUrl,
  getStreamInfo,
  getPlaylists,
  switchPlaylist,
  removePlaylist
} from './components/xtream-api.js';
import { VideoPlayer } from './components/player.js';
import { EPGGrid } from './components/epg.js';
import { navigation } from './components/tv-navigation.js';

// Application State
const state = {
  user: null,
  activeTab: 'live', // 'live', 'movies', 'series'
  activeCategory: null, // null until the user picks one (avoids auto-loading huge "All")
  activeChannel: null,
  activeProgram: null,
  favorites: {
    live: [],
    movie: [],
    series: []
  },
  counts: {
    favorites: 0,
    recently_viewed: 0
  },
  // VOD pagination & filters
  movies: {
    categoryId: 'all',
    page: 1,
    limit: 30,
    search: '',
    sort: 'added'
  },
  series: {
    categoryId: 'all',
    page: 1,
    limit: 30,
    search: '',
    sort: 'added'
  }
};

// Global Components instances
let playerInstance = null;
let epgGridInstance = null;
let liveFallbackTried = false; // guards the one-time .ts → m3u8 live fallback

// Clock update timer
let clockInterval = null;
let progressInterval = null;

// Document Ready
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  // 1. Initialize time clock
  startClock();

  // Show the build version (injected from package.json at build time)
  const versionEl = document.getElementById('app-version');
  if (versionEl && typeof __APP_VERSION__ !== 'undefined') {
    versionEl.textContent = `v${__APP_VERSION__}`;
  }

  // 2. Initialize Core Components
  playerInstance = new VideoPlayer();
  
  // Set player skip handlers
  playerInstance.setOnPrevChannel(() => playPreviousChannel());
  playerInstance.setOnNextChannel(() => playNextChannel());
  playerInstance.onExitVod = exitVodPlayer;

  epgGridInstance = new EPGGrid(
    (channel, program) => {
      selectAndPlayChannel(channel, program);
    },
    (channel, program) => {
      updateDetailsPanel(channel, program);
    }
  );

  // Provide global function for EPG stars updates
  window.isChannelFavorite = (type, id) => {
    return state.favorites[type]?.includes(String(id)) || false;
  };
  window.toggleChannelFavorite = toggleChannelFavorite;

  // 3. Bind Global UI Events (Tabs, Logins, Settings, Modal Closers)
  bindGlobalEvents();

  // 4. Check Connection Status
  try {
    const status = await getStatus();
    if (status.loggedIn) {
      state.user = status;
      showDashboard();
      
      // Load favorites from local state cache
      if (status.favorites) {
        state.favorites = status.favorites;
      }
      
      // Initial categories and streams load
      await loadTabCategoriesAndContent();
    } else {
      showLogin();
    }
  } catch (err) {
    console.error('Failed to initialize app session:', err);
    showLogin();
  }
}

// ==========================================================================
// TABS & VIEW ROUTER
// ==========================================================================
async function switchTab(tabId) {
  if (tabId !== 'series' || state.activeTab === 'series') {
    exitSeriesPlaybackDashboard();
  }
  state.activeTab = tabId;
  state.activeCategory = null;

  // Toggle tab buttons class
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Toggle visible panels
  document.querySelectorAll('.view-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `${tabId}-view`);
  });

  // Load left categories and main content area
  await loadTabCategoriesAndContent();
}

async function loadTabCategoriesAndContent() {
  try {
    // 1. Fetch categories for tab
    const res = await getCategories(state.activeTab);
    
    // Sync counts
    state.counts.favorites = res.counts.favorites || 0;
    state.counts.recently_viewed = res.counts.recently_viewed || 0;
    
    document.getElementById('count-favorites').textContent = state.counts.favorites;
    document.getElementById('count-recently-viewed').textContent = state.counts.recently_viewed;

    // 2. Render categories sidebar list
    renderCategoriesList(res.categories);

    // 3. Do NOT auto-load a category. The default "All" category can contain
    // thousands of channels and loading it on startup makes the app crawl.
    // Wait for the user to pick a category, and show a hint until then.
    showSelectCategoryHint();

    // TV Navigation: default focus categories
    navigation.focusDefault('categories');
  } catch (err) {
    console.error('Failed to load categories/content:', err);
  }
}

// Placeholder shown in the content area until the user picks a category
// (we no longer auto-load the big "All" category on startup).
function showSelectCategoryHint() {
  const hint = '<div class="select-category-hint">Select a category to load content</div>';
  if (state.activeTab === 'live') {
    const chList = document.getElementById('epg-channels-list');
    const progRows = document.getElementById('epg-programs-rows');
    if (chList) chList.innerHTML = hint;
    if (progRows) progRows.innerHTML = '';
    const visibleCount = document.getElementById('epg-visible-count');
    if (visibleCount) visibleCount.textContent = '(0)';
  } else if (state.activeTab === 'movies') {
    const grid = document.getElementById('movies-grid');
    if (grid) grid.innerHTML = hint;
  } else if (state.activeTab === 'series') {
    const grid = document.getElementById('series-grid');
    if (grid) grid.innerHTML = hint;
  }
}

// Render the categories side panel list
function renderCategoriesList(categories) {
  const container = document.getElementById('categories-list');
  container.innerHTML = '';

  // Add "All" node
  const allNode = document.createElement('div');
  allNode.className = `category-item ${state.activeCategory === 'all' ? 'active' : ''}`;
  allNode.dataset.category = 'all';
  
  let totalStreams = 0;
  categories.forEach(c => totalStreams += (c.count || 0));

  allNode.innerHTML = `
    <span class="cat-label">All ${state.activeTab === 'live' ? 'channels' : state.activeTab === 'movies' ? 'movies' : 'series'}</span>
    <span class="cat-count">${totalStreams}</span>
  `;
  allNode.addEventListener('click', () => selectCategory('all'));
  container.appendChild(allNode);

  // Add dynamic categories
  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = `category-item ${state.activeCategory === String(cat.category_id) ? 'active' : ''}`;
    item.dataset.category = String(cat.category_id);
    item.innerHTML = `
      <span class="cat-label">${cat.category_name}</span>
      <span class="cat-count">${cat.count || 0}</span>
    `;
    item.addEventListener('click', () => selectCategory(String(cat.category_id)));
    container.appendChild(item);
  });

  // Update categories total count text
  document.getElementById('categories-count-total').textContent = categories.length;
}

async function selectCategory(categoryId) {
  state.activeCategory = categoryId;
  
  // Highlight in list
  document.querySelectorAll('.category-item').forEach(item => {
    item.classList.toggle('active', item.dataset.category === categoryId);
  });

  // Highlight pins in list
  document.querySelectorAll('.pin-item').forEach(item => {
    item.classList.toggle('active', item.dataset.category === categoryId);
  });

  // Sync TV Focus
  const targetEl = document.querySelector(`.category-item[data-category="${categoryId}"]`) || 
                   document.querySelector(`.pin-item[data-category="${categoryId}"]`);
  if (targetEl) {
    navigation.setFocus('categories', targetEl);
  }

  // Close mobile sidebar drawer if open
  const appContainer = document.getElementById('app-container');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (appContainer && appContainer.classList.contains('sidebar-open')) {
    appContainer.classList.remove('sidebar-open');
    if (backdrop) backdrop.classList.add('hidden');
  }

  await loadCategoryContent();
}

async function loadCategoryContent() {
  if (state.activeTab === 'live') {
    // Live view: Fetch all streams for selected category and feed to EPG Grid
    // (EPG doesn't paginate internally because guide requires full list of active channels in timeline)
    const res = await getStreams({
      type: 'live',
      categoryId: state.activeCategory,
      page: 1,
      limit: 1000, // Load top 1000 channels of category to prevent browser layout crash
      search: ''
    });
    
    epgGridInstance.setChannels(res.items);
  } else if (state.activeTab === 'movies') {
    state.movies.categoryId = state.activeCategory;
    state.movies.page = 1;
    await loadMoviesGrid();
  } else if (state.activeTab === 'series') {
    state.series.categoryId = state.activeCategory;
    state.series.page = 1;
    await loadSeriesGrid();
  }
}

// ==========================================================================
// LIVE TV CONTROLS & STREAMING
// ==========================================================================
async function selectAndPlayChannel(channel, programBlock) {
  state.activeChannel = channel;
  state.activeProgram = programBlock;

  // Track history
  try {
    await trackPlayback(channel.stream_id);
    state.counts.recently_viewed = Math.min(50, state.counts.recently_viewed + 1);
    document.getElementById('count-recently-viewed').textContent = state.counts.recently_viewed;
  } catch (err) {
    console.warn('History tracking failed:', err);
  }

  // Live playback uses the Live-TV layout, never the VOD overlay.
  document.body.classList.remove('vod-mode');

  // Get stream URL (direct or proxy based on settings)
  try {
    const epgTitle = programBlock?.title || 'No Information';
    const streamUrl = await getStreamUrl(channel.stream_id, 'live');

    // Load to player
    playerInstance.setSeriesMode(false);
    playerInstance.loadStream(streamUrl, channel.name, channel.stream_icon, epgTitle);

    // If the primary (.ts) stream fails, fall back once to the m3u8 backup.
    liveFallbackTried = false;
    playerInstance.onFatalError = async () => {
      if (liveFallbackTried) return;
      liveFallbackTried = true;
      console.warn('Primary (.ts) stream failed — falling back to m3u8…');
      try {
        const fbUrl = await getStreamUrl(channel.stream_id, 'live', '', 'm3u8');
        playerInstance.setSeriesMode(false);
        playerInstance.loadStream(fbUrl, channel.name, channel.stream_icon, epgTitle);
      } catch (e) {
        console.error('m3u8 fallback failed:', e);
      }
    };

    // Show the channel-info banner with a short lineup (prev / current / next 2)
    const channelList = epgGridInstance?.channels || [];
    const currentIndex = channelList.findIndex(c => String(c.stream_id) === String(channel.stream_id));
    playerInstance.showChannelInfo(channel, channelList, currentIndex);

    // Show the one-line now/next guide for the current channel (cable-box style)
    const { current, next } = epgGridInstance?.getNowNext(channel.stream_id) || {};
    playerInstance.showProgramGuide(current || programBlock, next);

    // Automatically enter fullscreen
    playerInstance.enterFullscreen();

    // Set navigation focus to player zone
    navigation.focusDefault('player');

    // Update frontend Details Panel
    updateDetailsPanel(channel, programBlock);
  } catch (err) {
    console.error('Failed to start channel playback:', err);
    alert(`Could not start stream: ${err.message}`);
  }
}

function updateDetailsPanel(channel, program) {
  const channelIcon = document.getElementById('detail-channel-icon');
  const channelName = document.getElementById('detail-channel-name');
  const categoryName = document.getElementById('detail-category-name');
  const favBtn = document.getElementById('detail-favorite-btn');
  const favIcon = document.getElementById('detail-favorite-icon');

  const progTitle = document.getElementById('detail-program-title');
  const progTime = document.getElementById('detail-program-time');
  const progDesc = document.getElementById('detail-program-desc');
  const progProgress = document.getElementById('detail-program-progress');

  // Setup Logo
  if (channel.stream_icon) {
    channelIcon.src = channel.stream_icon;
    channelIcon.classList.remove('fallback-logo');
  } else {
    channelIcon.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="%234b5563" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="4"/></svg>';
    channelIcon.classList.add('fallback-logo');
  }

  channelName.textContent = channel.name || 'Live TV Channel';
  
  // Find category name
  const catItem = document.querySelector(`.category-item[data-category="${channel.category_id}"]`);
  categoryName.textContent = catItem ? catItem.querySelector('.cat-label').textContent : 'Live TV';

  // Favorite button state
  const isFav = window.isChannelFavorite('live', channel.stream_id);
  favBtn.classList.toggle('favorited', isFav);
  
  // Set programs details
  const progInfoContainer = document.querySelector('.details-program-info');
  const hasValidProgram = program && program.title && program.title !== 'No information available';

  if (hasValidProgram) {
    if (progInfoContainer) progInfoContainer.classList.remove('hidden');
    progTitle.textContent = program.title || 'No Information';
    
    const startMs = parseInt(program.start_timestamp) * 1000;
    const endMs = parseInt(program.end_timestamp) * 1000;
    const startStr = new Date(startMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const endStr = new Date(endMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    progTime.textContent = `${startStr} - ${endStr}`;
    
    progDesc.textContent = program.description || 'No program details available.';

    // Setup Progress Bar Auto Update
    clearInterval(progressInterval);
    const updateProgress = () => {
      const total = endMs - startMs;
      const elapsed = Date.now() - startMs;
      const pct = Math.max(0, Math.min(100, (elapsed / total) * 100));
      progProgress.style.width = `${pct}%`;
    };
    updateProgress();
    progressInterval = setInterval(updateProgress, 30000); // update progress bar every 30s
  } else {
    if (progInfoContainer) progInfoContainer.classList.add('hidden');
    progTitle.textContent = 'No Schedule Data';
    progTime.textContent = '12:00 AM - 12:00 AM';
    progDesc.textContent = 'No program details available.';
    progProgress.style.width = '0%';
    clearInterval(progressInterval);
  }
}

async function toggleChannelFavorite(type, id) {
  try {
    const res = await toggleFavorite(type, id);
    if (res.success) {
      if (res.isFavorite) {
        if (!state.favorites[type]) state.favorites[type] = [];
        state.favorites[type].push(String(id));
      } else {
        state.favorites[type] = state.favorites[type].filter(x => x !== String(id));
      }
      
      // Update sidebar badge
      state.counts.favorites = state.favorites[type].length;
      document.getElementById('count-favorites').textContent = state.counts.favorites;

      // Update active controls
      if (state.activeChannel && String(state.activeChannel.stream_id) === String(id)) {
        document.getElementById('detail-favorite-btn').classList.toggle('favorited', res.isFavorite);
      }

      // Update guide icons
      epgGridInstance.updateFavoritesHighlighting();

      // Refresh list if we are currently viewing the favorites category
      if (state.activeCategory === 'favorites') {
        await loadCategoryContent();
      }
    }
  } catch (err) {
    console.error('Toggle favorite failed:', err);
  }
}

function playNextChannel() {
  if (!state.activeChannel) return;
  const list = epgGridInstance.channels;
  const currentIndex = list.findIndex(c => String(c.stream_id) === String(state.activeChannel.stream_id));
  if (currentIndex !== -1 && currentIndex < list.length - 1) {
    const nextChan = list[currentIndex + 1];
    const targetRow = document.querySelector(`.epg-channel-row[data-stream-id="${nextChan.stream_id}"]`);
    if (targetRow) targetRow.click();
  }
}

function playPreviousChannel() {
  if (!state.activeChannel) return;
  const list = epgGridInstance.channels;
  const currentIndex = list.findIndex(c => String(c.stream_id) === String(state.activeChannel.stream_id));
  if (currentIndex > 0) {
    const prevChan = list[currentIndex - 1];
    const targetRow = document.querySelector(`.epg-channel-row[data-stream-id="${prevChan.stream_id}"]`);
    if (targetRow) targetRow.click();
  }
}

// ==========================================================================
// MOVIES VIEW (VOD)
// ==========================================================================
async function loadMoviesGrid() {
  const grid = document.getElementById('movies-grid');
  grid.innerHTML = '<div class="spinner-center"><div class="spinner"></div></div>';

  try {
    const res = await getStreams({
      type: 'movie',
      categoryId: state.movies.categoryId,
      page: state.movies.page,
      limit: state.movies.limit,
      search: state.movies.search
    });

    renderMoviesCatalog(res.items);
    renderPagination('movies', res.pagination);
  } catch (err) {
    grid.innerHTML = `<div class="error-msg">Failed to load movies: ${err.message}</div>`;
  }
}

function renderMoviesCatalog(movies) {
  const grid = document.getElementById('movies-grid');
  grid.innerHTML = '';

  if (movies.length === 0) {
    grid.innerHTML = '<div class="no-results">No movies found in this category.</div>';
    return;
  }

  movies.forEach(movie => {
    const card = document.createElement('div');
    card.className = 'vod-card';
    
    const rating = parseFloat(movie.rating) || 0;
    const year = movie.year || movie.releaseDate || 'N/A';
    const logo = movie.stream_icon || '';

    card.innerHTML = `
      <div class="vod-poster-wrapper">
        ${logo ? `<img src="${logo}" alt="" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22150%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%234b5563%22 stroke-width=%221%22><rect x=%222%22 y=%222%22 width=%2220%22 height=%2220%22 rx=%222%22/></svg>'">` : '<div class="poster-placeholder"><i data-lucide="film"></i></div>'}
        <div class="vod-card-overlay">
          <span class="vod-card-year">${year}</span>
          ${rating > 0 ? `<span class="vod-rating-badge"><i data-lucide="star"></i>${rating.toFixed(1)}</span>` : ''}
        </div>
      </div>
      <span class="vod-card-title">${movie.name}</span>
    `;

    card.addEventListener('click', () => {
      navigation.setFocus('grid', card);
      openVODDetailsModal(movie, 'movie');
    });
    grid.appendChild(card);
  });
  
  lucide.createIcons({ scope: grid });
  if (navigation.currentZone === 'grid') {
    navigation.focusDefault('grid');
  }
  navigation.triggerPendingFocus();
}

// ==========================================================================
// SERIES VIEW (VOD)
// ==========================================================================
async function loadSeriesGrid() {
  const grid = document.getElementById('series-grid');
  grid.innerHTML = '<div class="spinner-center"><div class="spinner"></div></div>';

  try {
    const res = await getStreams({
      type: 'series',
      categoryId: state.series.categoryId,
      page: state.series.page,
      limit: state.series.limit,
      search: state.series.search
    });

    renderSeriesCatalog(res.items);
    renderPagination('series', res.pagination);
  } catch (err) {
    grid.innerHTML = `<div class="error-msg">Failed to load series: ${err.message}</div>`;
  }
}

function renderSeriesCatalog(seriesList) {
  const grid = document.getElementById('series-grid');
  grid.innerHTML = '';

  if (seriesList.length === 0) {
    grid.innerHTML = '<div class="no-results">No series found in this category.</div>';
    return;
  }

  seriesList.forEach(series => {
    const card = document.createElement('div');
    card.className = 'vod-card';
    
    const rating = parseFloat(series.rating) || 0;
    const year = series.releaseDate || 'N/A';
    // Series posters live in `cover`/`cover_big`; `stream_icon` is movies-only.
    const logo = series.stream_icon || series.cover || series.cover_big || '';

    card.innerHTML = `
      <div class="vod-poster-wrapper">
        ${logo ? `<img src="${logo}" alt="" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22150%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%234b5563%22 stroke-width=%221%22><rect x=%222%22 y=%222%22 width=%2220%22 height=%2220%22 rx=%222%22/></svg>'">` : '<div class="poster-placeholder"><i data-lucide="tv"></i></div>'}
        <div class="vod-card-overlay">
          <span class="vod-card-year">${year}</span>
          ${rating > 0 ? `<span class="vod-rating-badge"><i data-lucide="star"></i>${rating.toFixed(1)}</span>` : ''}
        </div>
      </div>
      <span class="vod-card-title">${series.name}</span>
    `;

    // In Xtream Codes, TV Series items contain series_id instead of stream_id
    card.addEventListener('click', () => {
      navigation.setFocus('grid', card);
      openSeriesPlaybackDashboard(series);
    });
    grid.appendChild(card);
  });

  lucide.createIcons({ scope: grid });
  if (navigation.currentZone === 'grid') {
    navigation.focusDefault('grid');
  }
  navigation.triggerPendingFocus();
}

// TV Series Playback Dashboard controllers
async function openSeriesPlaybackDashboard(series) {
  const playbackContainer = document.getElementById('series-playback-container');
  const catalogContainer = document.getElementById('series-catalog-container');
  
  if (!playbackContainer || !catalogContainer) return;

  const title = document.getElementById('series-title');
  const rating = document.getElementById('series-rating');
  const yearBadge = document.getElementById('series-year');
  const coverImg = document.getElementById('series-cover-img');
  const plot = document.getElementById('series-plot');
  const select = document.getElementById('series-season-select');
  const episodesList = document.getElementById('series-episodes-list');
  const countNum = document.getElementById('series-episodes-count-num');
  
  if (title) title.textContent = series.name;
  if (rating) rating.innerHTML = `<i data-lucide="star"></i> ${parseFloat(series.rating)?.toFixed(1) || 'N/A'}`;
  if (yearBadge) yearBadge.textContent = series.releaseDate || series.year || 'N/A';
  if (coverImg) coverImg.src = series.stream_icon || series.cover || series.cover_big || '';
  if (plot) plot.textContent = 'Loading description details...';
  if (select) select.innerHTML = '';
  if (episodesList) episodesList.innerHTML = '<div class="spinner-center"><div class="spinner"></div></div>';
  if (countNum) countNum.textContent = '(0)';
  
  catalogContainer.classList.add('hidden');
  playbackContainer.classList.remove('hidden');
  
  // Relocate #video-container dynamically to series player wrapper
  const videoContainer = document.getElementById('video-container');
  const seriesPlayerWrapper = document.querySelector('.series-player-wrapper');
  if (videoContainer && seriesPlayerWrapper) {
    seriesPlayerWrapper.appendChild(videoContainer);
  }
  
  if (rating) lucide.createIcons({ scope: rating });
  
  if (playerInstance) {
    playerInstance.setOnPrevChannel(() => playPreviousEpisode());
    playerInstance.setOnNextChannel(() => playNextEpisode());
    playerInstance.onExitVod = () => {
      exitSeriesPlaybackDashboard();
    };
    playerInstance.onVideoEnded = () => {
      playNextEpisode();
    };
  }
  
  try {
    const info = await getStreamInfo(series.series_id, 'series');
    const infoMeta = info.info || {};
    
    if (plot) plot.textContent = infoMeta.plot || infoMeta.description || 'No summary available.';
    if (yearBadge) yearBadge.textContent = infoMeta.releasedate || infoMeta.releaseDate || infoMeta.year || yearBadge.textContent;
    
    const episodesMap = info.episodes || {};
    const seasons = Object.keys(episodesMap).sort((a, b) => parseInt(a) - parseInt(b));
    
    if (seasons.length === 0) {
      if (episodesList) episodesList.innerHTML = '<div class="no-results">No episodes available.</div>';
      return;
    }
    
    if (select) {
      seasons.forEach(seasonNum => {
        const opt = document.createElement('option');
        opt.value = seasonNum;
        opt.textContent = `Season ${seasonNum}`;
        select.appendChild(opt);
      });
    }
    
    const loadSeasonEpisodes = (seasonNum) => {
      if (!episodesList) return;
      episodesList.innerHTML = '';
      const episodes = episodesMap[seasonNum] || [];
      if (countNum) countNum.textContent = `(${episodes.length})`;
      
      if (episodes.length === 0) {
        episodesList.innerHTML = '<div class="no-results">No episodes in this season.</div>';
        return;
      }
      
      episodes.forEach((ep, epIdx) => {
        const row = document.createElement('div');
        row.className = 'episode-list-row';
        row.dataset.episodeId = ep.id;
        row.innerHTML = `
          <div class="episode-row-left-details">
            <span class="episode-row-title-text">Ep ${ep.episode_num || '0'}: ${ep.title || 'Episode'}</span>
            <span class="episode-row-duration-text">Duration: ${ep.info?.duration || 'N/A'}</span>
          </div>
          <i data-lucide="play-circle" class="episode-row-play-icon"></i>
        `;
        
        row.addEventListener('click', async () => {
          document.querySelectorAll('.episode-list-row').forEach(r => r.classList.remove('active'));
          row.classList.add('active');
          
          const epStreamId = ep.id;
          const epExt = ep.container_extension || ep.info?.container_extension || '';
          const epName = `${infoMeta.name || 'Series'} - S${seasonNum}E${ep.episode_num}: ${ep.title}`;
          
          await playSeriesEpisode(epStreamId, epName, infoMeta.cover, ep.info?.plot || '', epExt, epIdx, episodes, seasonNum, info);
        });
        
        episodesList.appendChild(row);
      });
      
      lucide.createIcons({ scope: episodesList });
    };
    
    if (select) {
      select.onchange = (e) => loadSeasonEpisodes(e.target.value);
    }
    
    loadSeasonEpisodes(seasons[0]);
    navigation.focusDefault('series-episodes');
    
  } catch (err) {
    console.error('Failed to load Series details:', err);
    if (plot) plot.textContent = 'Failed to load details from server.';
    if (episodesList) episodesList.innerHTML = '<div class="error-msg">Failed to load episodes.</div>';
  }
}

async function playSeriesEpisode(epStreamId, epName, logo, plot, epExt, epIndex, episodesListForSeason, seasonNum, seriesInfo) {
  if (!playerInstance) return;
  playerInstance.showSpinner();
  if (playerInstance.vodTitleTag) {
    playerInstance.vodTitleTag.textContent = epName || '';
  }
  
  state.seriesPlayback = {
    seriesInfo: seriesInfo,
    activeSeason: seasonNum,
    episodes: episodesListForSeason,
    currentIndex: epIndex
  };
  
  try {
    const playUrl = await getStreamUrl(epStreamId, 'series', epExt);
    playerInstance.setSeriesMode(true);
    playerInstance.loadStream(playUrl, epName, logo, '', true);

    // Show Now/Next Episode bar for Series
    const currentEp = episodesListForSeason[epIndex];
    const currentEpTitle = `S${seasonNum}E${currentEp.episode_num || (epIndex + 1)}: ${currentEp.title || 'Episode'}`;
    
    let nextEpName = '';
    if (epIndex + 1 < episodesListForSeason.length) {
      const nextEp = episodesListForSeason[epIndex + 1];
      nextEpName = `S${seasonNum}E${nextEp.episode_num || (epIndex + 2)}: ${nextEp.title || 'Episode'}`;
    } else {
      const episodesMap = seriesInfo.episodes || {};
      const seasons = Object.keys(episodesMap).sort((a, b) => parseInt(a) - parseInt(b));
      const currentSeasonIdx = seasons.indexOf(String(seasonNum));
      if (currentSeasonIdx !== -1 && currentSeasonIdx + 1 < seasons.length) {
        const nextSeasonNum = seasons[currentSeasonIdx + 1];
        const nextSeasonEpisodes = episodesMap[nextSeasonNum] || [];
        if (nextSeasonEpisodes.length > 0) {
          const firstEp = nextSeasonEpisodes[0];
          nextEpName = `S${nextSeasonNum}E${firstEp.episode_num || 1}: ${firstEp.title || 'Episode'}`;
        }
      }
    }
    playerInstance.showSeriesNowNext(currentEpTitle, nextEpName);

    playerInstance.enterFullscreen();
  } catch (err) {
    console.error('Failed to play Series episode:', err);
    alert(`Failed to load stream: ${err.message}`);
    playerInstance.hideSpinner();
  }
}

async function playNextEpisode() {
  if (!state.seriesPlayback || !state.seriesPlayback.seriesInfo) return;
  
  const { seriesInfo, activeSeason, episodes, currentIndex } = state.seriesPlayback;
  const select = document.getElementById('series-season-select');
  
  if (currentIndex + 1 < episodes.length) {
    const nextEp = episodes[currentIndex + 1];
    
    const rows = document.querySelectorAll('.episode-list-row');
    rows.forEach(r => r.classList.remove('active'));
    const targetRow = document.querySelector(`.episode-list-row[data-episode-id="${nextEp.id}"]`);
    if (targetRow) {
      targetRow.classList.add('active');
      targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    
    const epExt = nextEp.container_extension || nextEp.info?.container_extension || '';
    const epName = `${seriesInfo.info?.name || 'Series'} - S${activeSeason}E${nextEp.episode_num}: ${nextEp.title}`;
    await playSeriesEpisode(nextEp.id, epName, seriesInfo.info?.cover, nextEp.info?.plot || '', epExt, currentIndex + 1, episodes, activeSeason, seriesInfo);
  } else {
    const episodesMap = seriesInfo.episodes || {};
    const seasons = Object.keys(episodesMap).sort((a, b) => parseInt(a) - parseInt(b));
    const currentSeasonIdx = seasons.indexOf(String(activeSeason));
    
    if (currentSeasonIdx !== -1 && currentSeasonIdx + 1 < seasons.length) {
      const nextSeasonNum = seasons[currentSeasonIdx + 1];
      
      if (select) {
        select.value = nextSeasonNum;
      }
      
      const nextSeasonEpisodes = episodesMap[nextSeasonNum] || [];
      if (nextSeasonEpisodes.length > 0) {
        if (select) {
          const event = new Event('change');
          select.dispatchEvent(event);
        }
        
        const firstEp = nextSeasonEpisodes[0];
        setTimeout(async () => {
          const rows = document.querySelectorAll('.episode-list-row');
          rows.forEach(r => r.classList.remove('active'));
          const targetRow = document.querySelector(`.episode-list-row[data-episode-id="${firstEp.id}"]`);
          if (targetRow) {
            targetRow.classList.add('active');
            targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
          
          const epExt = firstEp.container_extension || firstEp.info?.container_extension || '';
          const epName = `${seriesInfo.info?.name || 'Series'} - S${nextSeasonNum}E${firstEp.episode_num}: ${firstEp.title}`;
          await playSeriesEpisode(firstEp.id, epName, seriesInfo.info?.cover, seriesInfo.info?.cover, epExt, 0, nextSeasonEpisodes, nextSeasonNum, seriesInfo);
        }, 100);
      }
    }
  }
}

async function playPreviousEpisode() {
  if (!state.seriesPlayback || !state.seriesPlayback.seriesInfo) return;
  
  const { seriesInfo, activeSeason, episodes, currentIndex } = state.seriesPlayback;
  const select = document.getElementById('series-season-select');
  
  if (currentIndex - 1 >= 0) {
    const prevEp = episodes[currentIndex - 1];
    
    const rows = document.querySelectorAll('.episode-list-row');
    rows.forEach(r => r.classList.remove('active'));
    const targetRow = document.querySelector(`.episode-list-row[data-episode-id="${prevEp.id}"]`);
    if (targetRow) {
      targetRow.classList.add('active');
      targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    
    const epExt = prevEp.container_extension || prevEp.info?.container_extension || '';
    const epName = `${seriesInfo.info?.name || 'Series'} - S${activeSeason}E${prevEp.episode_num}: ${prevEp.title}`;
    await playSeriesEpisode(prevEp.id, epName, seriesInfo.info?.cover, seriesInfo.info?.cover, epExt, currentIndex - 1, episodes, activeSeason, seriesInfo);
  } else {
    const episodesMap = seriesInfo.episodes || {};
    const seasons = Object.keys(episodesMap).sort((a, b) => parseInt(a) - parseInt(b));
    const currentSeasonIdx = seasons.indexOf(String(activeSeason));
    
    if (currentSeasonIdx > 0) {
      const prevSeasonNum = seasons[currentSeasonIdx - 1];
      
      if (select) {
        select.value = prevSeasonNum;
      }
      
      const prevSeasonEpisodes = episodesMap[prevSeasonNum] || [];
      if (prevSeasonEpisodes.length > 0) {
        if (select) {
          const event = new Event('change');
          select.dispatchEvent(event);
        }
        
        const lastEpIdx = prevSeasonEpisodes.length - 1;
        const lastEp = prevSeasonEpisodes[lastEpIdx];
        
        setTimeout(async () => {
          const rows = document.querySelectorAll('.episode-list-row');
          rows.forEach(r => r.classList.remove('active'));
          const targetRow = document.querySelector(`.episode-list-row[data-episode-id="${lastEp.id}"]`);
          if (targetRow) {
            targetRow.classList.add('active');
            targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
          
          const epExt = lastEp.container_extension || lastEp.info?.container_extension || '';
          const epName = `${seriesInfo.info?.name || 'Series'} - S${prevSeasonNum}E${lastEp.episode_num}: ${lastEp.title}`;
          await playSeriesEpisode(lastEp.id, epName, seriesInfo.info?.cover, seriesInfo.info?.cover, epExt, lastEpIdx, prevSeasonEpisodes, prevSeasonNum, seriesInfo);
        }, 100);
      }
    }
  }
}

function exitSeriesPlaybackDashboard() {
  const playbackContainer = document.getElementById('series-playback-container');
  const catalogContainer = document.getElementById('series-catalog-container');
  
  if (playbackContainer && !playbackContainer.classList.contains('hidden')) {
    playbackContainer.classList.add('hidden');
    if (catalogContainer) catalogContainer.classList.remove('hidden');
    
    if (playerInstance) {
      playerInstance.stop();
      playerInstance.setOnPrevChannel(() => playPreviousChannel());
      playerInstance.setOnNextChannel(() => playNextChannel());
      playerInstance.onExitVod = exitVodPlayer;
      playerInstance.onVideoEnded = null;
    }
    
    const videoContainer = document.getElementById('video-container');
    const livePlayerWrapper = document.querySelector('#live-view .player-wrapper');
    if (videoContainer && livePlayerWrapper) {
      livePlayerWrapper.appendChild(videoContainer);
    }
    navigation.focusDefault('grid');
  }
}

// Render pagination buttons in catalog footers
function renderPagination(type, pagination) {
  const container = document.getElementById(`${type}-pagination`);
  container.innerHTML = '';

  if (!pagination || pagination.pages <= 1) return;

  const current = pagination.page;
  const maxPages = pagination.pages;

  // Draw first / prev buttons
  if (current > 1) {
    const firstBtn = document.createElement('button');
    firstBtn.className = 'page-btn';
    firstBtn.innerHTML = '<i data-lucide="chevrons-left"></i>';
    firstBtn.addEventListener('click', () => setPage(type, 1));
    container.appendChild(firstBtn);

    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-btn';
    prevBtn.innerHTML = '<i data-lucide="chevron-left"></i>';
    prevBtn.addEventListener('click', () => setPage(type, current - 1));
    container.appendChild(prevBtn);
  }

  // Draw page numbers (sliding window of 5 pages)
  const windowSize = 5;
  let startPage = Math.max(1, current - Math.floor(windowSize / 2));
  let endPage = Math.min(maxPages, startPage + windowSize - 1);
  if (endPage - startPage + 1 < windowSize) {
    startPage = Math.max(1, endPage - windowSize + 1);
  }

  for (let i = startPage; i <= endPage; i++) {
    const pageBtn = document.createElement('button');
    pageBtn.className = `page-btn ${i === current ? 'active' : ''}`;
    pageBtn.textContent = i;
    pageBtn.addEventListener('click', () => setPage(type, i));
    container.appendChild(pageBtn);
  }

  // Draw next / last buttons
  if (current < maxPages) {
    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-btn';
    nextBtn.innerHTML = '<i data-lucide="chevron-right"></i>';
    nextBtn.addEventListener('click', () => setPage(type, current + 1));
    container.appendChild(nextBtn);

    const lastBtn = document.createElement('button');
    lastBtn.className = 'page-btn';
    lastBtn.innerHTML = '<i data-lucide="chevrons-right"></i>';
    lastBtn.addEventListener('click', () => setPage(type, maxPages));
    container.appendChild(lastBtn);
  }

  lucide.createIcons({ scope: container });
}

function setPage(type, pageNum) {
  if (type === 'movies') {
    state.movies.page = pageNum;
    loadMoviesGrid();
  } else {
    state.series.page = pageNum;
    loadSeriesGrid();
  }
}

// ==========================================================================
// MOVIE & SERIES DETAILS MODALS
// ==========================================================================
async function openVODDetailsModal(vodData, type) {
  const modal = document.getElementById('vod-modal');
  const title = document.getElementById('vod-modal-title');
  const rating = document.getElementById('vod-modal-rating');
  const poster = document.getElementById('vod-modal-poster');
  const genre = document.getElementById('vod-modal-genre');
  const release = document.getElementById('vod-modal-release');
  const duration = document.getElementById('vod-modal-duration');
  const plot = document.getElementById('vod-modal-plot');
  const director = document.getElementById('vod-modal-director');
  const cast = document.getElementById('vod-modal-cast');
  const playBtn = document.getElementById('vod-modal-play-btn');
  const seriesEpisodesContainer = document.getElementById('vod-series-episodes-container');

  // Clear modal values first
  title.textContent = vodData.name;
  rating.innerHTML = `<i data-lucide="star"></i> ${parseFloat(vodData.rating)?.toFixed(1) || 'N/A'}`;
  poster.src = vodData.stream_icon || vodData.cover || vodData.cover_big || '';
  genre.textContent = 'General';
  release.textContent = vodData.releaseDate || vodData.year || 'N/A';
  duration.textContent = 'N/A';
  plot.textContent = 'Loading description details...';
  director.textContent = 'Loading...';
  cast.textContent = 'Loading...';

  playBtn.classList.remove('hidden');
  seriesEpisodesContainer.classList.add('hidden');
  modal.classList.remove('hidden');
  navigation.focusDefault('modal');
  lucide.createIcons({ scope: rating });

  // Get dynamic ID (stream_id for movie, series_id for series)
  const queryId = type === 'series' ? vodData.series_id : vodData.stream_id;

  try {
    const info = await getStreamInfo(queryId, type);
    
    // Parse metadata
    const infoMeta = info.info || {};
    plot.textContent = infoMeta.plot || infoMeta.description || 'No summary available.';
    director.textContent = infoMeta.director || 'N/A';
    cast.textContent = infoMeta.cast || infoMeta.actors || 'N/A';
    release.textContent = infoMeta.releasedate || infoMeta.releaseDate || infoMeta.year || release.textContent;
    genre.textContent = infoMeta.genre || genre.textContent;

    if (type === 'movie') {
      const runTime = infoMeta.duration_secs ? `${Math.floor(infoMeta.duration_secs / 60)}m` : infoMeta.duration || 'N/A';
      duration.textContent = runTime;

      // Play Movie Action
      const movieExt = info.movie_data?.container_extension || infoMeta.container_extension || '';
      playBtn.onclick = async () => {
        modal.classList.add('hidden');
        await playVODStream(queryId, 'movie', vodData.name, vodData.stream_icon, plot.textContent, movieExt);
      };
    } else if (type === 'series') {
      // It's a Series, hide direct play button and show Episode Lists
      playBtn.classList.add('hidden');
      duration.textContent = `${info.seasons?.length || 0} Seasons`;
      
      seriesEpisodesContainer.classList.remove('hidden');
      renderSeriesSeasons(info);
    }
    
    // Refresh modal focus list since elements have loaded
    navigation.focusDefault('modal');
  } catch (err) {
    console.error('Failed to load VOD info:', err);
    plot.textContent = 'Failed to load details from server.';
    director.textContent = 'N/A';
    cast.textContent = 'N/A';
  }
}

// Populate series season selector and episodes list
function renderSeriesSeasons(seriesInfo) {
  const select = document.getElementById('seasons-dropdown');
  const episodesList = document.getElementById('episodes-list');
  select.innerHTML = '';
  episodesList.innerHTML = '';

  const episodesMap = seriesInfo.episodes || {};
  const seasons = Object.keys(episodesMap);

  if (seasons.length === 0) {
    episodesList.innerHTML = '<div class="no-results">No episodes available.</div>';
    return;
  }

  // Add options
  seasons.forEach(seasonNum => {
    const opt = document.createElement('option');
    opt.value = seasonNum;
    opt.textContent = `Season ${seasonNum}`;
    select.appendChild(opt);
  });

  // Render episodes on dropdown change
  const loadSeasonEpisodes = (seasonNum) => {
    episodesList.innerHTML = '';
    const episodes = episodesMap[seasonNum] || [];

    episodes.forEach(ep => {
      const row = document.createElement('div');
      row.className = 'episode-row';
      row.innerHTML = `
        <div class="episode-row-left">
          <span class="episode-title">Ep ${ep.episode_num || '0'}: ${ep.title || 'Episode'}</span>
          <span class="episode-meta">Duration: ${ep.info?.duration || 'N/A'}</span>
        </div>
        <i data-lucide="play-circle" class="episode-play-icon"></i>
      `;
      row.addEventListener('click', async () => {
        document.getElementById('vod-modal').classList.add('hidden');
        
        // Each episode is its own stream: identified by ep.id and played from a
        // file with its own container extension (mp4/mkv/…).
        const epStreamId = ep.id;
        const epExt = ep.container_extension || ep.info?.container_extension || '';
        const epName = `${seriesInfo.info?.name || 'Series'} - S${seasonNum}E${ep.episode_num}: ${ep.title}`;
        await playVODStream(epStreamId, 'series', epName, seriesInfo.info?.cover, ep.info?.plot || '', epExt);
      });
      episodesList.appendChild(row);
    });

    lucide.createIcons({ scope: episodesList });
  };

  select.onchange = (e) => loadSeasonEpisodes(e.target.value);
  
  // Initial load season 1
  loadSeasonEpisodes(seasons[0]);
}

async function playVODStream(streamId, type, name, logo, description, containerExtension = '') {
  // VOD plays in its own full-screen player overlay (movies/series), NOT the
  // Live-TV layout. We don't switch tabs — the overlay sits over the catalog.
  document.body.classList.add('vod-mode');
  
  // Programmatically hide the sidebar, header, EPG guide, and details panel
  document.querySelector('.sidebar')?.classList.add('hidden');
  document.querySelector('.top-header')?.classList.add('hidden');
  document.querySelector('.epg-section-container')?.classList.add('hidden');
  document.querySelector('.program-details-panel')?.classList.add('hidden');

  if (playerInstance.vodTitleTag) playerInstance.vodTitleTag.textContent = name || '';

  playerInstance.showSpinner();
  try {
    const playUrl = await getStreamUrl(streamId, type, containerExtension);

    // VOD = on-demand file, played differently from live channels (seekable).
    playerInstance.setSeriesMode(false);
    playerInstance.loadStream(playUrl, name, logo, '', true);
  } catch (err) {
    console.error('Failed to play VOD stream:', err);
    alert(`Failed to load stream: ${err.message}`);
    playerInstance.hideSpinner();
  }
}

// Leave the VOD player overlay and return to the catalog grid.
function exitVodPlayer() {
  document.body.classList.remove('vod-mode');
  
  // Programmatically restore layout elements
  document.querySelector('.sidebar')?.classList.remove('hidden');
  document.querySelector('.top-header')?.classList.remove('hidden');
  document.querySelector('.epg-section-container')?.classList.remove('hidden');

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  playerInstance.stop();
}

// ==========================================================================
// DOCK WIDGETS & MODAL BINDS
// ==========================================================================
function startClock() {
  const timeEl = document.getElementById('current-time');
  const dateEl = document.getElementById('current-date');

  const update = () => {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    dateEl.textContent = now.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  };
  
  update();
  clearInterval(clockInterval);
  clockInterval = setInterval(update, 1000);
}

function bindGlobalEvents() {
  // Login Form Connect
  const loginForm = document.getElementById('login-form');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const playlistName = document.getElementById('playlist-name').value;
    const hostUrl = document.getElementById('host-url').value;
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    const errorMsg = document.getElementById('login-error');
    const btnText = document.querySelector('#login-btn .btn-text');
    const loader = document.querySelector('#login-btn .btn-loader');

    errorMsg.classList.add('hidden');
    btnText.classList.add('hidden');
    loader.classList.remove('hidden');

    try {
      const res = await login(hostUrl, username, password, playlistName);
      if (res.success) {
        const status = await getStatus();
        state.user = status;
        if (status.favorites) {
          state.favorites = status.favorites;
        }
        showDashboard();
        
        // Trigger initial sync
        await triggerFullSync();
        await loadTabCategoriesAndContent();
      }
    } catch (err) {
      errorMsg.textContent = err.message || 'Login connection failed.';
      errorMsg.classList.remove('hidden');
    } finally {
      btnText.classList.remove('hidden');
      loader.classList.add('hidden');
    }
  });

  // Playlist switcher dropdown
  const profileBtn = document.getElementById('profile-card-btn');
  if (profileBtn) {
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlaylistDropdown();
    });
  }
  document.getElementById('playlist-add-btn')?.addEventListener('click', showAddPlaylist);
  document.getElementById('playlist-dropdown-list')?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      deletePlaylist(del.getAttribute('data-del'));
      return;
    }
    const row = e.target.closest('.playlist-row');
    if (!row) return;
    if (row.classList.contains('active')) {
      closePlaylistDropdown();
    } else {
      switchToPlaylist(row.dataset.id);
    }
  });
  document.getElementById('login-back-btn')?.addEventListener('click', () => {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    document.getElementById('login-back-btn').classList.add('hidden');
  });
  // Close the dropdown when clicking outside of it
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('playlist-dropdown');
    if (dd && !dd.classList.contains('hidden') && !e.target.closest('.profile-wrap')) {
      dd.classList.add('hidden');
    }
  });

  // Settings Binds
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsClose = document.getElementById('settings-close-btn');

  settingsBtn.addEventListener('click', () => {
    // Populate settings
    if (state.user && state.user.credentials) {
      const creds = state.user.credentials;
      document.getElementById('settings-format').value = creds.stream_format || 'ts';
      document.getElementById('settings-proxy').checked = creds.proxy_streams ?? true;
      document.getElementById('settings-connected-server').textContent = creds.server_url;
    }
    settingsModal.classList.remove('hidden');
    navigation.focusDefault('modal');
  });

  settingsClose.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
    navigation.focusDefault('tabs');
  });

  // Save Settings
  document.getElementById('settings-format').addEventListener('change', async (e) => {
    await updatePreferences({ stream_format: e.target.value });
  });

  document.getElementById('settings-proxy').addEventListener('change', async (e) => {
    await updatePreferences({ proxy_streams: e.target.checked });
  });

  // Sync now click
  document.getElementById('settings-sync-now').addEventListener('click', async () => {
    settingsModal.classList.add('hidden');
    await triggerFullSync();
    await loadTabCategoriesAndContent();
  });

  // Logout Click
  document.getElementById('settings-logout').addEventListener('click', async () => {
    if (confirm('Are you sure you want to disconnect this playlist? This will erase local cache.')) {
      settingsModal.classList.add('hidden');
      playerInstance.stop();
      const res = await logout();
      if (res && res.remaining > 0) {
        await switchToPlaylist(res.activeId);
      } else {
        state.user = null;
        showLogin();
      }
    }
  });

  // Modal Closers
  document.getElementById('vod-modal-close').addEventListener('click', () => {
    document.getElementById('vod-modal').classList.add('hidden');
  });

  // Close modals on background overlay click
  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      e.target.classList.add('hidden');
    }
  });

  // Navigation tab binds
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Sidebar Pins Binds
  document.querySelectorAll('.pin-item').forEach(pin => {
    pin.addEventListener('click', () => {
      const cat = pin.dataset.category;
      selectCategory(cat);
    });
  });

  // Categories list Search
  const catSearch = document.getElementById('categories-search');
  catSearch.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    document.querySelectorAll('#categories-list .category-item').forEach(item => {
      const label = item.querySelector('.cat-label').textContent.toLowerCase();
      // Keep "all channels" visible or apply query
      if (item.dataset.category === 'all') return;
      item.classList.toggle('hidden', !label.includes(query));
    });
  });



  // Detail panel favorite button click
  document.getElementById('detail-favorite-btn').addEventListener('click', () => {
    if (state.activeChannel) {
      toggleChannelFavorite('live', state.activeChannel.stream_id);
    }
  });

  // Global Sync Header Button
  document.getElementById('sync-btn').addEventListener('click', async () => {
    await triggerFullSync();
    await loadTabCategoriesAndContent();
  });

  // Mobile Hamburger Menu Binds
  const menuBtn = document.getElementById('mobile-menu-btn');
  const backdrop = document.getElementById('sidebar-backdrop');
  const appContainer = document.getElementById('app-container');

  if (menuBtn && backdrop && appContainer) {
    menuBtn.addEventListener('click', () => {
      appContainer.classList.add('sidebar-open');
      backdrop.classList.remove('hidden');
    });

    backdrop.addEventListener('click', () => {
      appContainer.classList.remove('sidebar-open');
      backdrop.classList.add('hidden');
    });
  }

  // Collapsible "Pin top section" (accordion)
  const pinSection = document.getElementById('pin-top-section');
  const pinToggle = document.getElementById('pin-section-toggle');
  if (pinSection && pinToggle) {
    // Restore saved state
    if (localStorage.getItem('pin_section_collapsed') === 'true') {
      pinSection.classList.add('collapsed');
      pinToggle.setAttribute('aria-expanded', 'false');
    }

    const togglePinSection = () => {
      const collapsed = pinSection.classList.toggle('collapsed');
      pinToggle.setAttribute('aria-expanded', String(!collapsed));
      localStorage.setItem('pin_section_collapsed', String(collapsed));
    };

    pinToggle.addEventListener('click', togglePinSection);
    pinToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePinSection();
      }
    });
  }

  // Catalog Searches
  const movieSearchInput = document.getElementById('movies-search');
  let movieSearchTimeout;
  movieSearchInput.addEventListener('input', (e) => {
    clearTimeout(movieSearchTimeout);
    movieSearchTimeout = setTimeout(() => {
      state.movies.search = e.target.value;
      state.movies.page = 1;
      loadMoviesGrid();
    }, 450);
  });

  const seriesSearchInput = document.getElementById('series-search');
  let seriesSearchTimeout;
  seriesSearchInput.addEventListener('input', (e) => {
    clearTimeout(seriesSearchTimeout);
    seriesSearchTimeout = setTimeout(() => {
      state.series.search = e.target.value;
      state.series.page = 1;
      loadSeriesGrid();
    }, 450);
  });

  // TV Series Playback Back button
  document.getElementById('series-back-btn')?.addEventListener('click', () => {
    exitSeriesPlaybackDashboard();
  });
}

async function updatePreferences(prefs) {
  try {
    const res = await updateSettings(prefs);
    if (res.success && state.user) {
      state.user.credentials = res.credentials;
    }
  } catch (err) {
    console.error('Failed to update settings preferences:', err);
  }
}

// Show a full-screen loading blocker during Xtream playlist sync
async function triggerFullSync() {
  const syncBlocker = document.createElement('div');
  syncBlocker.className = 'modal-overlay';
  syncBlocker.style.zIndex = '10000';
  syncBlocker.innerHTML = `
    <div style="text-align: center; display: flex; flex-direction: column; align-items: center; gap: 20px; color: white;">
      <div class="spinner" style="width: 60px; height: 60px;"></div>
      <h2 style="font-family: var(--font-title); font-size: 1.8rem; font-weight: 700;">Syncing Playlist Data</h2>
      <p id="sync-progress-msg" style="color: var(--text-secondary); max-width: 400px; font-size: 0.95rem; line-height: 1.5;">
        Initializing connection to your provider...
      </p>
    </div>
  `;
  document.body.appendChild(syncBlocker);

  try {
    const progressEl = document.getElementById('sync-progress-msg');
    const res = await syncPlaylist((statusText) => {
      if (progressEl) {
        progressEl.textContent = statusText;
      }
    });
    console.log('Sync completed! Channels cached:', res.counts);
  } catch (err) {
    console.error('Playlist sync failed:', err);
    alert(`Sync Warning: Could not download latest channels list. Using previously cached data if available. (${err.message})`);
  } finally {
    syncBlocker.remove();
  }
}

// ==========================================================================
// SESSION SCREEN TRANSITIONS
// ==========================================================================
function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  document.getElementById('login-back-btn')?.classList.add('hidden');
}

// ==========================================================================
// PLAYLIST SWITCHER (multiple saved logins)
// ==========================================================================
function closePlaylistDropdown() {
  document.getElementById('playlist-dropdown')?.classList.add('hidden');
}

async function renderPlaylistDropdown() {
  const listEl = document.getElementById('playlist-dropdown-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="playlist-row-empty">Loading…</div>';
  try {
    const { playlists, activeId } = await getPlaylists();
    if (!playlists || playlists.length === 0) {
      listEl.innerHTML = '<div class="playlist-row-empty">No saved playlists</div>';
      return;
    }
    listEl.innerHTML = '';
    playlists.forEach(p => {
      let domain = p.server_url;
      try { domain = new URL(p.server_url).hostname; } catch (e) {}
      const row = document.createElement('div');
      row.className = 'playlist-row' + (p.id === activeId ? ' active' : '');
      row.dataset.id = p.id;
      row.innerHTML = `
        <div class="playlist-row-main">
          <span class="playlist-row-name">${p.playlistName || 'Playlist'}</span>
          <span class="playlist-row-server">${domain} · ${p.username}</span>
        </div>
        ${p.id === activeId ? '<i data-lucide="check" class="playlist-row-check"></i>' : ''}
        <button class="playlist-row-del" data-del="${p.id}" title="Remove playlist"><i data-lucide="trash-2"></i></button>
      `;
      listEl.appendChild(row);
    });
    if (window.lucide) lucide.createIcons({ scope: listEl });
  } catch (err) {
    listEl.innerHTML = '<div class="playlist-row-empty">Failed to load playlists</div>';
  }
}

async function togglePlaylistDropdown() {
  const dd = document.getElementById('playlist-dropdown');
  if (!dd) return;
  if (dd.classList.contains('hidden')) {
    await renderPlaylistDropdown();
    dd.classList.remove('hidden');
  } else {
    dd.classList.add('hidden');
  }
}

async function switchToPlaylist(id) {
  closePlaylistDropdown();
  try {
    playerInstance.stop();
    exitSeriesPlaybackDashboard();
    await switchPlaylist(id);
    const status = await getStatus();
    state.user = status;
    if (status.favorites) state.favorites = status.favorites;
    showDashboard();
    await triggerFullSync();
    state.activeCategory = null;
    await loadTabCategoriesAndContent();
  } catch (err) {
    console.error('Failed to switch playlist:', err);
    alert('Could not switch playlist: ' + (err.message || err));
  }
}

async function deletePlaylist(id) {
  if (!confirm('Remove this playlist?')) return;
  try {
    const res = await removePlaylist(id);
    if (!res.remaining) {
      state.user = null;
      showLogin();
      return;
    }
    if (res.wasActive) {
      await switchToPlaylist(res.activeId);
    }
    await renderPlaylistDropdown();
  } catch (err) {
    alert('Could not remove playlist: ' + (err.message || err));
  }
}

function showAddPlaylist() {
  closePlaylistDropdown();
  document.getElementById('app-container').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-back-btn')?.classList.remove('hidden');
  document.getElementById('host-url').value = '';
  document.getElementById('username').value = '';
  document.getElementById('password').value = '';
  const err = document.getElementById('login-error');
  if (err) err.classList.add('hidden');
}

function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  document.getElementById('login-back-btn')?.classList.add('hidden');

  // Set topbar credentials details
  if (state.user && state.user.credentials) {
    const creds = state.user.credentials;
    
    // Format simple name e.g. "your-provider-url.com" from host
    let domain = creds.server_url;
    try {
      const urlObj = new URL(creds.server_url);
      domain = urlObj.hostname;
    } catch(e){}

    document.getElementById('nav-playlist-name').textContent = `${creds.playlistName} (${domain})`;
  }

  // Set expiry text
  if (state.user && state.user.user_info) {
    const info = state.user.user_info;
    const expiryEl = document.getElementById('expiry-text');
    
    if (info.exp_date === null || info.exp_date === undefined || info.exp_date === '0') {
      expiryEl.textContent = 'Active - Unlimited';
    } else {
      const expDate = new Date(parseInt(info.exp_date) * 1000);
      const diffTime = expDate - Date.now();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays <= 0) {
        expiryEl.textContent = 'Expired';
        expiryEl.parentElement.classList.replace('gold-badge', 'danger-badge');
      } else if (diffDays <= 7) {
        expiryEl.textContent = `${diffDays} days left`;
      } else {
        expiryEl.textContent = `Expires ${expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      }
    }
  }

  // Set SVG lucide icons
  lucide.createIcons();
}
