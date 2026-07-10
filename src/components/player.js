import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Upscaler } from './upscaler.js';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { proxifyImage } from './xtream-api.js';
import {
  isNativeAvailable, nativePlay, nativeStop, nativePlayCtl, nativePauseCtl,
  nativeSeek, nativeSetVolume, nativeSetRect, setScreenAwake
} from './native-player.js';

function getQualityTag(name) {
  const n = String(name).toLowerCase();
  if (n.includes('4k') || n.includes('uhd')) return '4K';
  if (n.includes('fhd') || n.includes('1080')) return 'FHD';
  if (n.includes('hd') || n.includes('720')) return 'HD';
  if (n.includes('sd') || n.includes('480') || n.includes('576')) return 'SD';
  return '';
}

function getQualityBadgeHtml(name) {
  const tag = getQualityTag(name);
  if (!tag) return '';
  return `<span class="quality-badge badge-${tag.toLowerCase()}">${tag}</span>`;
}

function replaceUrlExtension(url, newExt) {
  try {
    const urlObj = new URL(url);
    let pathname = urlObj.pathname;
    const lastDot = pathname.lastIndexOf('.');
    const lastSlash = pathname.lastIndexOf('/');
    if (lastDot > lastSlash) {
      pathname = pathname.substring(0, lastDot) + '.' + newExt;
    } else {
      pathname = pathname + '.' + newExt;
    }
    urlObj.pathname = pathname;
    return urlObj.toString();
  } catch (e) {
    return url;
  }
}

function removeUrlExtension(url) {
  try {
    const urlObj = new URL(url);
    let pathname = urlObj.pathname;
    const lastDot = pathname.lastIndexOf('.');
    const lastSlash = pathname.lastIndexOf('/');
    if (lastDot > lastSlash) {
      pathname = pathname.substring(0, lastDot);
    }
    urlObj.pathname = pathname;
    return urlObj.toString();
  } catch (e) {
    return url;
  }
}

export class VideoPlayer {
  constructor() {
    // Mark the native (Android app) build so CSS can switch the player to the
    // boxed/fullscreen-toggle model (and hide the VOD player box while browsing).
    try { if (Capacitor.isNativePlatform()) document.body.classList.add('app-native'); } catch (e) {}
    this._wasLandscape = this.isLandscape();
    this.video = document.getElementById('main-video-player');
    this.controls = document.getElementById('player-controls');
    this.playPauseBtn = document.getElementById('player-play-pause-btn');
    this.prevBtn = document.getElementById('player-prev-btn');
    this.nextBtn = document.getElementById('player-next-btn');
    this.ccBtn = document.getElementById('player-cc-btn');
    this.volumeBtn = document.getElementById('player-volume-btn');
    this.volumeSlider = document.getElementById('player-volume-slider');
    this.fullscreenBtn = document.getElementById('player-fullscreen-btn');
    this.channelNameEl = document.getElementById('player-channel-name');
    this.epgTitleEl = document.getElementById('player-epg-title');
    this.spinner = document.getElementById('video-spinner');
    this.idleScreen = document.getElementById('player-idle');
    this.watermark = document.getElementById('player-watermark');
    this.watermarkImg = document.getElementById('watermark-img');
    this.pipBtn = document.getElementById('player-pip-btn');
    this.stopBtn = document.getElementById('player-stop-btn');
    this.infoBtn = document.getElementById('player-info-btn');
    this.deintBtn = document.getElementById('player-deint-btn');
    this.fpsIndicatorEl = document.getElementById('player-fps-indicator');
    this.qualityBadgeEl = document.getElementById('player-quality-badge');
    this.currentFps = 30;
    this.fpsInterval = null;
    this.currentChannelName = '';

    // Channel info banner (brief OSD on channel change)
    this.channelInfoBanner = document.getElementById('channel-info-banner');
    this.cibLogo = document.getElementById('cib-logo');
    this.cibLogoImg = document.getElementById('cib-logo-img');
    this.cibName = document.getElementById('cib-name');
    this.cibDatetime = document.getElementById('cib-datetime');
    this.cibList = document.getElementById('cib-list');
    this.channelInfoTimeout = null;

    // Now/Next one-line guide (flip bar)
    this.nowNextBar = document.getElementById('now-next-bar');
    this.nnbNow = document.getElementById('nnb-now');
    this.nnbNowTime = document.getElementById('nnb-now-time');
    this.nnbNowTitle = document.getElementById('nnb-now-title');
    this.nnbNext = document.getElementById('nnb-next');
    this.nnbNextTime = document.getElementById('nnb-next-time');
    this.nnbNextTitle = document.getElementById('nnb-next-title');
    this.nnbSep = document.getElementById('nnb-sep');
    this.nowNextTimeout = null;

    // VOD-only controls (movies / series)
    this.backBtn = document.getElementById('player-back-btn');
    this.seek = document.getElementById('player-seek');
    this.timeCurrent = document.getElementById('player-time-current');
    this.timeDuration = document.getElementById('player-time-duration');
    this.liveBadge = document.getElementById('player-live-badge');
    this.rewind10Btn = document.getElementById('player-rewind-10');
    this.forward10Btn = document.getElementById('player-forward-10');
    this.vodTitleTag = document.getElementById('player-vod-title');
    this.onExitVod = null;
    this.isSeeking = false;
    this.onFatalError = null; // live: invoked when the primary (.ts) stream fails
    this.onVodProgress = null; // VOD/series: (currentTime, duration) for Continue Watching
    this.pendingSeek = 0; // resume position to seek to once metadata loads
    this.isVodActive = false;
    if (this.seek) {
      this.updateSeekBackground();
    }

    this.hls = null;
    this.mpegtsPlayer = null;
    this.controlsTimeout = null;
    this.onPrevChannelCallback = null;
    this.onNextChannelCallback = null;
    this.onVideoEnded = null;
    this.isVod = false;

    // Retry state — reset on every new loadStream() call
    this._retryCount = 0;
    this._retryTimer = null;
    this._streamUrl = null;
    this._streamIsVod = false;

    this.initEventListeners();
  }

  initEventListeners() {
    // Play / Pause click
    this.playPauseBtn.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('click', () => this.togglePlay());

    // Prev / Next click
    this.prevBtn.addEventListener('click', () => {
      if (this.onPrevChannelCallback) this.onPrevChannelCallback();
    });
    this.nextBtn.addEventListener('click', () => {
      if (this.onNextChannelCallback) this.onNextChannelCallback();
    });

    // Volume change
    this.volumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      this.video.volume = vol;
      this.video.muted = vol === 0;
      if (this._nativeActive) nativeSetVolume(vol);
      // While casting, also drive the TV's volume.
      if (this._castMode && window.castControls && window.castControls.isActive()) {
        window.castControls.setVolume(vol);
      }
      this.updateVolumeIcon();
    });

    this.volumeBtn.addEventListener('click', () => {
      if (this._castMode && window.castControls && window.castControls.isActive()) {
        window.castControls.toggleMute();
      }
      this.video.muted = !this.video.muted;
      this.updateVolumeIcon();
    });

    // Fullscreen
    this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    this.video.addEventListener('dblclick', () => this.toggleFullscreen());

    // Store handler as a named property so it can be removed in destroy()
    this._onFullscreenChange = () => {
      if (document.fullscreenElement) {
        if (Capacitor.isNativePlatform()) {
          ScreenOrientation.lock({ orientation: 'landscape' })
            .catch(err => console.log('Capacitor orientation lock failed:', err));
        } else if (screen.orientation && typeof screen.orientation.lock === 'function') {
          screen.orientation.lock('landscape').catch(err => console.log('Web orientation lock skipped:', err));
        }
        this.fullscreenBtn.innerHTML = '<i data-lucide="minimize"></i>';
      } else {
        if (Capacitor.isNativePlatform()) {
          ScreenOrientation.unlock()
            .catch(err => console.log('Capacitor orientation unlock failed:', err));
        } else if (screen.orientation && typeof screen.orientation.unlock === 'function') {
          try {
            screen.orientation.unlock();
          } catch (e) {}
        }
        this.fullscreenBtn.innerHTML = '<i data-lucide="maximize"></i>';
        document.body.style.cursor = 'default';
      }
      // Force the native surface rect to re-sync to the new (fullscreen/inline)
      // box bounds on the next poll tick instead of waiting for a change to be
      // detected — keeps the video from lagging a frame behind the transition.
      if (this._nativeActive) this._lastRectKey = null;
      // In native fullscreen the ::backdrop is transparent (so the video shows),
      // which would also reveal the app chrome behind it — flag the body so CSS can
      // hide that chrome, leaving only the fullscreen player subtree over the video.
      document.body.classList.toggle('native-fullscreen', !!document.fullscreenElement && this._nativeActive);
      lucide.createIcons({ scope: this.fullscreenBtn });
    };
    document.addEventListener('fullscreenchange', this._onFullscreenChange);

    // Stop playback (tear down the stream entirely).
    if (this.stopBtn) {
      this.stopBtn.addEventListener('click', () => {
        // For VOD, Stop should leave the player overlay entirely (restore chrome,
        // exit fullscreen) — otherwise the user is stranded on the idle screen in
        // browser fullscreen. Live keeps the plain stop() behaviour.
        if (this.isVodActive && typeof this.onExitVod === 'function') this.onExitVod();
        else this.stop();
      });
    }

    // Audio & Subtitles menu (falls back to a simple caption toggle).
    this.ccBtn.addEventListener('click', () => {
      if (typeof window.openPlayerTrackMenu === 'function') window.openPlayerTrackMenu();
      else this.toggleCaptions();
    });

    // Info button toggle channel details panel
    if (this.infoBtn) {
      this.infoBtn.addEventListener('click', () => {
        // On TV the side details panel is hidden by the single-column layout, so
        // reveal it as an overlay instead (toggle on repeat press / Back).
        if (document.body.classList.contains('tv-layout')) {
          document.body.classList.toggle('tv-info-open');
          return;
        }
        const topRow = document.querySelector('.live-top-row');
        if (topRow) {
          topRow.classList.toggle('details-collapsed');
        }
      });
    }

    // VOD seek bar (movies / series only)
    if (this.seek) {
      this.video.addEventListener('timeupdate', () => {
        if (!this.isSeeking) {
          const d = this._totalDuration();
          const cur = this._currentTime();
          if (d && isFinite(d)) {
            this.seek.value = (cur / d) * 100;
            this.timeCurrent.textContent = this.formatTime(cur);
            this.updateSeekBackground();
          }
        }
        // Track the last steadily-playing position on every live stream — the
        // 'seeking' anti-jump guard compares against it to spot backward seeks
        // we didn't request (engine error-recovery fallout).
        if (!this._streamIsVod && !this.video.seeking && !this.isSeeking) {
          this._lastPlayTime = this.video.currentTime;
        }
        // Timeshift: light the LIVE badge red when we're at the live edge,
        // dim it when watching behind (YouTube-style). Measure against hls.js's
        // own live position so it reads "live" right after goLive (which targets
        // that position, ~18 s back from the true, still-growing edge).
        if (this._timeshiftActive) {
          let atLive;
          if (this.hls && isFinite(this.hls.liveSyncPosition)) {
            atLive = this.video.currentTime >= this.hls.liveSyncPosition - 8;
          } else {
            const w = this._tsWindow();
            atLive = w ? (w.end - this.video.currentTime) < 20 : false;
          }
          if (this.liveBadge) this.liveBadge.classList.toggle('at-live', atLive);
          // YouTube-style: at the live edge hide the scrubber handle + fill the
          // bar red; show the handle again once the user rewinds.
          document.body.classList.toggle('ts-at-live', atLive);
          // Can't skip forward past live — grey out +10 at the edge.
          if (this.forward10Btn) this.forward10Btn.disabled = atLive;
          // Last-resort drift guard: unexpected back-seeks are corrected
          // instantly by the 'seeking' guard, so this should almost never fire.
          // Only a truly broken state (>2 min behind while meant to be live)
          // snaps forward — small stall-induced drift is left alone so
          // playback never visibly leaps.
          if (this._wantLive && !atLive && !this.video.paused && !this.isSeeking) {
            let live = NaN;
            if (this.hls && isFinite(this.hls.liveSyncPosition)) live = this.hls.liveSyncPosition;
            else { const w = this._tsWindow(); if (w) live = w.end - 10; }
            if (isFinite(live) && live - this.video.currentTime > 120) {
              console.warn('[timeshift] far behind live — snapping back');
              this.goLive();
            }
          }
        } else if (this.forward10Btn) {
          this.forward10Btn.disabled = false; // VOD: forward always allowed
        }
        // Report progress for Continue Watching (VOD / series only)
        if (this.isVodActive && this.onVodProgress) {
          this.onVodProgress(this._currentTime(), this._totalDuration());
        }
      });
      const refreshDuration = () => {
        const d = this._totalDuration();
        this.timeDuration.textContent = (d && isFinite(d)) ? this.formatTime(d) : '';
      };
      this._refreshTimeUi = refreshDuration;
      const seekToResume = () => {
        // A transcoded stream starts at its requested offset, so the element's
        // currentTime is already correct (0 = _transcodeOffset) — don't re-seek it.
        if (this._transcodeActive) return;
        if (this.pendingSeek > 0 && isFinite(this.video.duration)) {
          try { this.video.currentTime = this.pendingSeek; } catch (e) {}
          this.pendingSeek = 0;
        }
      };
      this.video.addEventListener('loadedmetadata', refreshDuration);
      this.video.addEventListener('loadedmetadata', seekToResume);
      this.video.addEventListener('canplay', seekToResume);
      this.video.addEventListener('durationchange', refreshDuration);
      this.seek.addEventListener('input', () => {
        this.isSeeking = true;
        this.updateSeekBackground();
      });
      this.seek.addEventListener('change', () => {
        // While casting, seek the TV (the bar is a 0..100 percentage).
        if (this._castMode && window.castControls && window.castControls.isActive()) {
          window.castControls.seekFraction(this.seek.value / 100);
          this.isSeeking = false;
          return;
        }
        if (this._nativeActive) {
          const d = this._nativeDuration || 0;
          if (d > 0) nativeSeek((this.seek.value / 100) * d);
          this.isSeeking = false;
          return;
        }
        const d = this._totalDuration();
        if (this._transcodeActive) {
          // Piped fMP4 isn't byte-range seekable — re-request the transcode at the
          // new offset (server -ss) and resume from there.
          if (d && isFinite(d)) this._seekTranscode((this.seek.value / 100) * d);
          this.isSeeking = false;
          return;
        }
        if (this._timeshiftActive) {
          // Scrub within the DVR window: map 0..100 onto [seekable.start, end].
          const w = this._tsWindow();
          this._expectSeek = true;
          if (w) { try { this.video.currentTime = w.start + (this.seek.value / 100) * (w.end - w.start); } catch (e) {} }
          // Scrubbing near the right edge means "live"; anywhere else is a
          // deliberate rewind — stop the drift guard from yanking them forward.
          this._wantLive = this.seek.value >= 98;
          this.isSeeking = false;
          return;
        }
        if (d && isFinite(d)) this.video.currentTime = (this.seek.value / 100) * d;
        this.isSeeking = false;
        this.updateSeekBackground();
      });
    }

    // VOD back button → exit the VOD player and return to the catalog
    if (this.backBtn) {
      this.backBtn.addEventListener('click', () => {
        // VOD/series have an explicit exit handler; for live (no handler) just stop,
        // which removes the native overlay and restores the chrome/channel list.
        if (this.onExitVod) this.onExitVod();
        else this.stop();
      });
    }

    // Controls visibility timeout
    const container = this.video.parentElement;
    container.addEventListener('mousemove', () => this.showControlsTemporarily());
    container.addEventListener('mouseleave', () => this.hideControls());
    // Touch: tapping toggles the controls (and restarts the auto-hide timer) so
    // they can be dismissed to see the video on a touchscreen.
    container.addEventListener('touchstart', () => {
      const visible = this.controls.style.opacity === '1';
      if (visible) this.hideControls();
      else this.showControlsTemporarily();
    }, { passive: true });

    // Video play/pause states to sync controls UI
    this.video.addEventListener('play', () => {
      this.playPauseBtn.innerHTML = '<i class="play-icon" data-lucide="pause"></i>';
      lucide.createIcons({ attrs: { class: 'play-icon' }, nameList: ['pause'], scope: this.playPauseBtn });
      
      if (Capacitor.isNativePlatform()) {
        try {
          const PipPlugin = registerPlugin('PipPlugin');
          PipPlugin.setPlaybackState({ active: true });
        } catch (e) {
          console.error('Failed to notify play state:', e);
        }
      }
    });

    // Anti-jump guard (ALL live, incl. timeshift): engine error-recovery
    // (hls.js media-error flushes, mpegts rebuilds) can silently re-seek
    // playback backwards into the buffer — that's the "skips back and it's no
    // longer live" bug. Every deliberate seek (scrub / ±10s / goLive / resume)
    // sets _expectSeek first, so any OTHER backward seek is recovery fallout:
    // undo it immediately, before a single frame of old content plays.
    this.video.addEventListener('seeking', () => {
      if (this._streamIsVod || this._expectSeek) return;
      const t = this.video.currentTime;
      // 1.5s tolerance: every deliberate seek is flagged with _expectSeek, so
      // any unrequested backward move beyond a hiccup is recovery fallout. The
      // old 5s threshold let smaller flush-jumps through — each one visibly
      // replayed content.
      if (!isFinite(this._lastPlayTime) || this._lastPlayTime - t <= 1.5) return;
      if (this._timeshiftActive) {
        if (!this._wantLive) {
          // Deliberately behind live (DVR pause/rewind): don't yank to the
          // edge, but don't let recovery replay either — restore the position
          // we were actually playing.
          console.warn(`[timeshift] unexpected back-seek (${(this._lastPlayTime - t).toFixed(1)}s) while behind live — restoring position`);
          this._expectSeek = true;
          try { this.video.currentTime = this._lastPlayTime; } catch (e) {}
          return;
        }
        console.warn(`[timeshift] unexpected back-seek (${(this._lastPlayTime - t).toFixed(1)}s) — restoring live position`);
        this.goLive();
        return;
      }
      // Plain live: snap back to the live edge (hls.js's own live position, or
      // the end of the buffered range for mpegts/direct).
      let live = NaN;
      if (this.hls && isFinite(this.hls.liveSyncPosition)) {
        live = this.hls.liveSyncPosition;
      } else {
        try {
          const b = this.video.buffered;
          if (b && b.length) live = b.end(b.length - 1) - 1;
        } catch (e) {}
      }
      if (isFinite(live) && live > t) {
        console.warn(`[live] unexpected back-seek (${(this._lastPlayTime - t).toFixed(1)}s) — restoring live edge`);
        this._expectSeek = true;
        try { this.video.currentTime = live; } catch (e) {}
      }
    });
    this.video.addEventListener('seeked', () => {
      this._expectSeek = false;
      this._lastPlayTime = this.video.currentTime;
    });

    this.video.addEventListener('pause', () => {
      // Pausing live is a deliberate step behind the edge (DVR pause) — the
      // drift guard must not yank playback forward on resume. LIVE/Go-Live re-arms.
      this._wantLive = false;
      this.playPauseBtn.innerHTML = '<i class="play-icon" data-lucide="play"></i>';
      lucide.createIcons({ attrs: { class: 'play-icon' }, nameList: ['play'], scope: this.playPauseBtn });
      
      if (Capacitor.isNativePlatform()) {
        try {
          const PipPlugin = registerPlugin('PipPlugin');
          PipPlugin.setPlaybackState({ active: false });
        } catch (e) {
          console.error('Failed to notify pause state:', e);
        }
      }
    });

    // Picture in Picture event bindings
    if (this.pipBtn) {
      this.pipBtn.addEventListener('click', () => this.togglePiP());
      
      // Hide PiP button if not supported in the web browser
      if (!Capacitor.isNativePlatform() && !document.pictureInPictureEnabled) {
        this.pipBtn.classList.add('hidden');
      }
    }

    // Native Capacitor PiP state changes listener
    if (Capacitor.isNativePlatform()) {
      try {
        const PipPlugin = registerPlugin('PipPlugin');
        PipPlugin.addListener('pipModeChanged', (data) => {
          if (data.isInPip) {
            document.body.classList.add('pip-mode-active');
          } else {
            document.body.classList.remove('pip-mode-active');
          }
        });
      } catch (err) {
        console.error('Failed to register native PipPlugin listener:', err);
      }
    }

    // Browser standard PiP events fallback
    this.video.addEventListener('enterpictureinpicture', () => {
      document.body.classList.add('pip-mode-active');
      if (!Capacitor.isNativePlatform()) {
        // Restore layout sidebar & top-header for desktop/browser browsing
        document.querySelector('.sidebar')?.classList.remove('hidden');
        document.querySelector('.top-header')?.classList.remove('hidden');
        if (document.body.classList.contains('vod-mode')) {
          document.body.classList.remove('vod-mode');
          if (window.state && window.state.activeTab) {
            if (typeof window.switchTab === 'function') {
              window.switchTab(window.state.activeTab);
            } else {
              const homeTab = document.querySelector('.nav-tab[data-tab="home"]');
              if (homeTab) homeTab.click();
            }
          } else {
            const homeTab = document.querySelector('.nav-tab[data-tab="home"]');
            if (homeTab) homeTab.click();
          }
        }
      }
    });
    this.video.addEventListener('leavepictureinpicture', () => {
      document.body.classList.remove('pip-mode-active');
      if (!Capacitor.isNativePlatform()) {
        const isStillPlaying = !this.video.paused;
        if (isStillPlaying) {
          if (typeof window.switchTab === 'function') {
            window.switchTab('live');
          }
          if (this.isVodActive) {
            document.body.classList.add('vod-mode');
            document.querySelector('.sidebar')?.classList.add('hidden');
            document.querySelector('.top-header')?.classList.add('hidden');
          }
        } else {
          this.stop();
        }
      }
    });

    // Dynamic quality and FPS tracking
    this.video.addEventListener('loadedmetadata', () => {
      clearTimeout(this._vodLoadTimeout);
      this.updateQualityIndicator();
    });
    this.video.addEventListener('resize', () => this.updateQualityIndicator());
    this.video.addEventListener('play', () => this.startFpsTracker());
    this.video.addEventListener('playing', () => {
      clearTimeout(this._vodLoadTimeout);
      this.updateQualityIndicator();
      this.startFpsTracker();
      // Playback is healthy again — clear the retry budget and media-recover
      // tally so a stream that hiccups occasionally over hours doesn't slowly
      // exhaust the lifetime retry limit and get killed.
      this._retryCount = 0;
      this._hlsMediaRecover = null;
    });
    this.video.addEventListener('pause', () => this.stopFpsTracker());
    this.video.addEventListener('ended', () => {
      this.stopFpsTracker();
      // A piped transcode "ends" wherever the ffmpeg pipe died — if the real
      // (probed) duration says we're nowhere near the end, this is a dropped
      // upstream connection, not the credits. Resume instead of auto-advancing
      // to the next episode.
      if (this._transcodeActive && this._transcodeDuration > 0) {
        const realPos = this._transcodeOffset + this.video.currentTime;
        if (this._transcodeDuration - realPos > 5) {
          console.warn(`[vod] transcode ended prematurely at ${realPos.toFixed(0)}s of ${this._transcodeDuration.toFixed(0)}s — resuming`);
          this._recoverVodStall(true);
          return;
        }
      }
      // Auto-advance: for series this triggers the next episode (set in main.js).
      // Null for movies/live, so it safely no-ops there. Was dropped in v2.7.0
      // when FPS tracking replaced this handler, breaking series autoplay.
      if (typeof this.onVideoEnded === 'function') this.onVideoEnded();
    });
    this.video.addEventListener('emptied', () => this.stopFpsTracker());

    // Global video error handler for native/direct playback
    this.video.addEventListener('error', (e) => {
      if (this._castMode) return;
      
      const err = this.video.error;
      console.warn('Native video error event captured:', err);
      
      // If we are currently playing via HLS or MPEG-TS libraries, they handle their own errors.
      const isDirectPlay = !this.hls && !this.mpegtsPlayer;
      if (isDirectPlay && this.hasStream) {
        if (this.isVod) {
          // If we haven't played much yet (less than 2 seconds), attempt format fallback.
          // Otherwise, treat it as a playback interruption.
          if (this.video.currentTime < 2) {
            this._handleVodPlaybackFallback(err);
          } else if (err && (err.code === 2 || err.code === 4)) {
            // Network drop mid-playback (server closed the connection).
            // Reload the source and resume where we stalled — same recovery
            // as the silent-stall watchdog. Only surfaces an error once the
            // reconnect budget is spent.
            console.warn('[vod] network error mid-playback — attempting resume');
            this._recoverVodStall(true);
          } else {
            let errMsg = 'VOD playback interrupted.';
            if (err) {
              if (err.code === 3) errMsg = 'Video decoding failed.';
              if (err.message) errMsg += ` (${err.message})`;
            }
            this.showError(errMsg);
          }
        } else {
          // Live TV direct play fallback
          console.warn('Live direct play failed, scheduling retry...');
          this._retryStream();
        }
      }
    });

    // Orientation-aware fullscreen (phones): while a stream is active, rotating
    // to landscape enters fullscreen; rotating back to portrait exits it. Auto-
    // fullscreen on play only happens in landscape (see autoFullscreen()).
    try {
      this._landscapeMql = window.matchMedia('(orientation: landscape)');
      const onOrient = (e) => {
        if (!this.hasStream) return;
        if (Capacitor.isNativePlatform()) {
          // Native phone: fullscreen strictly follows orientation — landscape =
          // immersive, portrait = docked (never a portrait fullscreen). TV exempt.
          if (this._isTv()) return;
          this._applyFsForOrientation();
          return;
        }
        if (e.matches) this.enterFullscreen();
        else this.exitFullscreen();
      };
      if (this._landscapeMql.addEventListener) this._landscapeMql.addEventListener('change', onOrient);
      else if (this._landscapeMql.addListener) this._landscapeMql.addListener(onOrient); // legacy WebView
    } catch (e) {}
    // matchMedia 'change' can be unreliable in Android WebViews; window 'resize'
    // and the screen orientationchange fire dependably when the viewport flips, so
    // re-derive the native fullscreen state from them too.
    const reapplyFs = () => { if (Capacitor.isNativePlatform() && !this._isTv()) this._applyFsForOrientation(); };
    window.addEventListener('resize', reapplyFs);
    window.addEventListener('orientationchange', reapplyFs);

    // TV devices (Fire TV / Android TV): pressing Home backgrounds the app,
    // and these low-RAM boxes reclaim the media pipeline (or kill the process)
    // while backgrounded — playback is dead when the user comes back. So on
    // background: snapshot what's playing, stop and release the decoders
    // (which is also what Fire TV guidelines expect); on foreground: reload
    // the same stream — live re-tunes to the edge, VOD resumes at position.
    // Phones are exempt: background audio keeps playing there by design.
    if (Capacitor.isNativePlatform()) {
      try {
        App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) {
            if (!this._isTv() || !this.hasStream || !this._streamUrl || this._castMode) return;
            const meta = this._lastLoadMeta || {};
            this._bgResume = {
              url: this._streamUrl,
              name: meta.name || this.currentChannelName,
              logo: meta.logo || '',
              epg: meta.epg || '',
              isVod: this._streamIsVod,
              pos: this._streamIsVod
                ? (this._nativeActive ? (this._lastNativeCur || 0) : this._currentTime())
                : 0,
            };
            console.warn('[player] app backgrounded on TV — releasing playback, will resume');
            this.stop();
          } else if (this._bgResume) {
            const r = this._bgResume;
            this._bgResume = null;
            console.warn('[player] app foregrounded — resuming playback');
            this.loadStream(r.url, r.name, r.logo, r.epg, r.isVod, r.pos);
          }
        });
      } catch (e) {}
    }
  }

  isLandscape() {
    try { return window.matchMedia('(orientation: landscape)').matches; } catch (e) { return true; }
  }

  // Auto-fullscreen on play — but only in landscape. In portrait we stay inline
  // so the user can keep browsing; rotating to landscape fullscreens it.
  _isTv() { return document.body.classList.contains('tv-layout'); }

  autoFullscreen() {
    // Native phone: starting playback in landscape goes straight to immersive.
    // TV: starting playback goes fullscreen too (Back returns to the boxed
    // player + grid — see tv-navigation handleBack). Web keeps its behavior.
    if (Capacitor.isNativePlatform()) {
      if (this._isTv()) { this._setFsDirect(true); return; }
      const isL = this.isLandscape();
      this._wasLandscape = isL;
      this._setFsDirect(isL);
      return;
    }
    // Desktop (Electron): stay boxed so the details panel stays visible next to
    // the video. /tv mode keeps the immersive auto-fullscreen behavior.
    if (this._isElectron() && !this._isTv()) return;
    if (this.isLandscape()) this.enterFullscreen();
  }

  exitFullscreen() {
    if (Capacitor.isNativePlatform()) {
      this._setFsDirect(false); // back to BOXED (landscape stays landscape)
      // Release the lock so a phone can rotate freely again — but NEVER force
      // portrait (TV has none; that was the "exit goes portrait" bug).
      if (!this._isTv()) { try { ScreenOrientation.unlock().catch(() => {}); } catch (e) {} }
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  setOnPrevChannel(callback) {
    this.onPrevChannelCallback = callback;
  }

  setOnNextChannel(callback) {
    this.onNextChannelCallback = callback;
  }

  setSeriesMode(active) {
    if (!this.container) return;
    if (active) {
      this.container.classList.add('series-mode');
    } else {
      this.container.classList.remove('series-mode');
    }
  }

  showSeriesNowNext(currentEpTitle, nextEpTitle) {
    if (!this.nowNextBar) return;

    this.nnbNowTime.textContent = '';
    this.nnbNowTitle.textContent = currentEpTitle;

    if (nextEpTitle) {
      this.nnbNextTime.textContent = '';
      this.nnbNextTitle.textContent = nextEpTitle;
      this.nnbNext.style.display = '';
      this.nnbSep.style.display = '';
    } else {
      this.nnbNext.style.display = 'none';
      this.nnbSep.style.display = 'none';
    }

    this.nowNextBar.classList.add('visible');
    clearTimeout(this.nowNextTimeout);
    this.nowNextTimeout = setTimeout(() => {
      this.nowNextBar.classList.remove('visible');
    }, 15000); // Display for 15 seconds
  }

  // Desktop live: route the channel through the server's rolling ~30-sec
  // in-memory HLS timeshift buffer so the user can pause and rewind briefly. One
  // ffmpeg pulls the stream once (no double connection → no provider connection-
  // limit trip); the player reads the local playlist. Returns false if it can't
  // start, so the caller can fall back to the normal direct live path.
  async loadLiveTimeshift(streamUrl, ch, name, logo, currentEpg = 'No schedule available') {
    if (!this._isElectron()) return false;
    // Show the player + spinner immediately so the click feels instant; the
    // buffer takes a few seconds to spin up and we don't want to block on it.
    this._enterLiveUi(name, logo, currentEpg);
    const target = this._transcodeTarget(streamUrl);
    try {
      const deintQ = this._deinterlaceOn() ? '&deint=1' : '';
      const r = await fetch(`/api/timeshift/start?url=${encodeURIComponent(target)}&ch=${encodeURIComponent(ch)}${deintQ}`);
      if (!r.ok) return false;
      const { playlist } = await r.json();
      if (!playlist) return false;
      this._pendingTimeshift = true;            // read by loadStream → _playAsHls
      this.loadStream(playlist, name, logo, currentEpg, false);
      return true;
    } catch (e) {
      console.warn('[timeshift] start failed, using direct live:', e && e.message);
      return false;
    }
  }

  // Show the live player shell + spinner right away (before playback is ready),
  // so fullscreen and the channel name appear the instant the user clicks.
  _enterLiveUi(name, logo, epg) {
    this.hasStream = true;
    document.body.classList.add('player-session');
    document.body.classList.remove('vod-mode');
    if (this.idleScreen) this.idleScreen.classList.add('hidden');
    this.currentChannelName = name || 'Live Channel';
    if (this.channelNameEl) {
      this.channelNameEl.innerHTML = `<span class="player-channel-name-text">${this.currentChannelName}</span>`;
    }
    if (this.epgTitleEl && epg) this.epgTitleEl.textContent = epg;
    if (logo && this.watermarkImg && this.watermark) {
      this.watermarkImg.src = proxifyImage(logo);
      this.watermark.classList.remove('hidden');
    }
    this.showSpinner();
  }

  loadStream(url, name, logo, currentEpg = 'No schedule available', isVod = false, resumeTime = 0) {
    // Only one thing plays at a time across the whole app: a local stream
    // starting here silences every custom web tab (no double audio).
    try { window.stopAllWebtabPlayback?.(); } catch (e) {}
    this.isVod = isVod;
    this.isVodActive = isVod;
    this.hasStream = true; // gates orientation-driven fullscreen
    this.pendingSeek = isVod ? (resumeTime || 0) : 0;
    if (this.seek) {
      this.seek.value = 0;
      this.updateSeekBackground();
    }
    if (this.idleScreen) this.idleScreen.classList.add('hidden'); // a stream is starting
    // Mark an active playback session from the moment of tap (loading → playing), so
    // the VOD player box appears immediately with the spinner — not only once libVLC
    // reaches "ready" (native-video-active). Removed in stop().
    document.body.classList.add('player-session');
    // Keep the phone screen on for the duration of playback (Android APK).
    setScreenAwake(true);
    this.showSpinner();
    this.currentChannelName = name || 'Live Channel';
    this._currentLogo = logo || '';
    const qBadge = getQualityBadgeHtml(this.currentChannelName);
    this.channelNameEl.innerHTML = `
      <span class="player-channel-name-text">${this.currentChannelName}</span>
      ${qBadge}
    `;
    this.epgTitleEl.textContent = currentEpg;
    if (this.fpsIndicatorEl) {
      this.fpsIndicatorEl.textContent = 'Loading...';
    }
    if (this.qualityBadgeEl) {
      this.qualityBadgeEl.classList.remove('visible');
    }

    if (logo) {
      this.watermarkImg.src = proxifyImage(logo);
      this.watermark.classList.remove('hidden');
    } else {
      this.watermark.classList.add('hidden');
    }

    // Reset retry state for the new stream
    clearTimeout(this._retryTimer);
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._vodLoadTimeout);
    this._stopVodStallWatch();
    this._stopLiveStallWatch();
    this._retryCount = 0;
    this._nativeRecoverCount = 0;
    this._nativeProgressSince = null;
    this._lastNativeCur = 0;
    this._streamUrl = url;
    this._streamIsVod = isVod;
    this._lastLoadMeta = { name, logo, epg: currentEpg }; // for background-resume snapshot
    this._triedMpegtsOriginal = false;
    this._triedHlsOriginal = false;
    this._triedMpegtsRewritten = false;
    this._triedHlsRewritten = false;
    this._triedExtensionless = false;
    // Desktop-only: server-side ffmpeg transcode fallback for premium VOD
    // (HEVC + E-AC3) the browser can't play. Two tiers: audio-only, then full.
    this._triedTranscodeAudio = false;
    this._triedTranscodeFull = false;
    // Transcode seek state: active flag, current segment base offset (s), real
    // total duration (s, from /api/probe), and which tier is streaming.
    this._transcodeActive = false;
    this._transcodeOffset = 0;
    this._transcodeDuration = 0;
    this._transcodeMode = null;
    // Timeshift: true only when this load is the rolling DVR HLS buffer (set by
    // loadLiveTimeshift just before this call). Default off for VOD/direct/recordings.
    this._timeshiftActive = !!this._pendingTimeshift;
    this._pendingTimeshift = false;
    // Live-intent flag: true while the user means to watch the live edge.
    // Cleared when they rewind/scrub back/pause; restored by goLive(). The
    // timeupdate drift guard uses it to snap back if playback silently slips
    // behind live (stall recovery, media-error recovery, buffer hiccups).
    this._wantLive = this._timeshiftActive;
    this._lastPlayTime = NaN;  // fresh stream — no stale anti-jump reference
    this._expectSeek = false;
    document.body.classList.toggle('timeshift-active', this._timeshiftActive);
    // Bumped on every new stream so a pending live reconnect for an old
    // channel cancels itself once the user has switched away.
    this._streamGen = (this._streamGen || 0) + 1;

    // Stop existing streams
    this.destroyHls();
    this.destroyMpegts();
    this.hlsNetworkRetries = 0;

    this._beginPlayback(url, isVod, this.pendingSeek);
  }

  // Native-first playback: try the device's native player (libVLC on Android) which
  // decodes E-AC3/AC3, HEVC and MKV that the browser <video> can't. On any
  // failure/timeout, fall back to the browser engine so native issues never
  // regress working playback. Electron/web have no native layer (Electron uses the
  // server ffmpeg transcode fallback instead; see _playViaTranscode).
  async _beginPlayback(url, isVod, resumeTime = 0) {
    this._nativeActive = false;
    this._nativeSawLife = false;
    let useNative = true;
    try {
      useNative = localStorage.getItem('playerEngine') !== 'web';
    } catch (e) {}

    if (isNativeAvailable() && useNative && !this._castMode) {
      try {
        // debug toast removed in production
        await nativePlay(
          { url, isLive: !isVod, startAt: isVod ? (resumeTime || 0) : 0, title: this.currentChannelName },
          {
            onReady: () => { this.hideSpinner(); },
            onTime: (d) => this._onNativeTime(d),
            onEnded: () => { if (typeof this.onVideoEnded === 'function') this.onVideoEnded(); },
            onError: (d) => this._onNativeError(d),
            // While loading: reflect the real libVLC state so a buffer loop is
            // visible as buffering, not a generic spinner. After we've committed
            // to native, a buffering event re-shows the loading overlay.
            onBuffering: (d) => {
              this._nativeSawLife = true;
              const pct = d && typeof d.percent === 'number' ? Math.round(d.percent) : null;
              this._showNativeStatus(pct != null ? `Buffering ${pct}%…` : 'Buffering…');
            },
            onState: (d) => {
              const s = (d && d.state) || '';
              if (s) this._nativeSawLife = true;
              this._updateNativeHud({ state: s });
              if (s === 'opening') this._showNativeStatus('Opening stream…');
              else if (s.startsWith('vout')) this._showNativeStatus('Starting video…');
              else if (s === 'playing') this.hideSpinner();
            },
            onVout: (d) => {
              this._nativeSawLife = true;
              this._nativeVout = d && typeof d.count === 'number' ? d.count : this._nativeVout;
              this._updateNativeHud({ vout: this._nativeVout });
            },
          }
        );
        this._nativeActive = true;
        this._nativePaused = false;
        document.body.classList.add('native-video-active');
        this.hideSpinner();
        this._setPlayPauseIcon(true);
        this._startNativeStallWatch();
        // Boxed-by-default: the surface tracks the on-screen player box (full-screen
        // only when body.player-fs makes the box fill the viewport).
        this._startRectSync();
        // Kick the auto-hide timer so the controls fade and reveal the video
        // (mouse-move events don't fire on touch, so without this they'd persist).
        this.showControlsTemporarily();
        return;
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        const sawLife = !!(e && e.sawLife) || this._nativeSawLife;
        console.warn('[player] native playback failed:', msg, '(sawLife:', sawLife, ')');
        try { await nativeStop(); } catch (_) {}
        document.body.classList.remove('native-video-active');
        this._nativeActive = false;

        // If libVLC actually opened the stream but couldn't sustain playback
        // (sawLife) and this is VOD, the browser <video>/mpegts/hls path cannot
        // decode it either (MKV/HEVC Main10/E-AC3) — falling through would just
        // spin forever. Show a clear, actionable error instead.
        if (sawLife && isVod) {
          if (window.showToast) window.showToast(`Native could not play this title (${msg})`, 'error', 6000);
          this.showError(
            'This title could not be played. The native player opened the stream but ' +
            'could not decode it smoothly — your device may be too slow to software-decode ' +
            'this format (10-bit HEVC), or the connection stalled. Try again, lower quality, or another title.'
          );
          return;
        }
        // Engine never showed signs of life (or it's live) → browser fallback.
        // fallback toast removed in production
      }
    } else if (this._isElectron()) {
      // Desktop (Electron): no libVLC layer. Honor the user's Desktop Player
      // preference — 'ffmpeg' forces the server-side ffmpeg transcode straight
      // away (best for premium HEVC/E-AC3 VOD the browser can't decode); 'html5'
      // (default) uses the browser <video>/hls.js/mpegts.js chain, with transcode
      // still available as an automatic fallback via _handleVodPlaybackFallback.
      let desktopEngine = 'ffmpeg';
      try { desktopEngine = localStorage.getItem('electronEngine') || 'ffmpeg'; } catch (e) {}

      // External Player: hand the stream to the user's default media player (via a
      // temp .m3u the Electron main process opens). Works for live + VOD. On
      // success we return to the catalog; on failure we fall back to in-app.
      if (desktopEngine === 'external' && !this._castMode &&
          window.appHost && typeof window.appHost.openInPlayer === 'function') {
        const target = this._transcodeTarget(url); // unwrap /api/proxy → real upstream
        Promise.resolve(window.appHost.openInPlayer({ url: target, title: this.currentChannelName }))
          .then((r) => {
            if (r && r.ok) {
              if (window.showToast) window.showToast('Opening in your default player…', 'success', 3000);
              this.stop();
            } else {
              const detail = r && r.error ? ` (${r.error})` : '';
              if (window.showToast) window.showToast(`Couldn't open external player${detail} — playing in-app`, 'error', 5000);
              this._startPlayback(url, isVod);
            }
          })
          .catch((e) => {
            if (window.showToast) window.showToast("Couldn't open external player — playing in-app", 'error', 4000);
            this._startPlayback(url, isVod);
          });
        return;
      }

      if (desktopEngine === 'ffmpeg' && isVod && !this._castMode) {
        this._triedTranscodeAudio = true;
        this._playViaTranscode('audio');
        return;
      }
    } else if (window.showToast && isVod) {
      window.showToast('Native player not available on this platform', 'error', 4000);
    }
    this._startPlayback(url, isVod);
  }

  // Custom loading text in the spinner area (mirrors showSpinner() styling but
  // with a state-specific message). Used to surface native libVLC progress.
  _showNativeStatus(text) {
    if (!this.spinner) return;
    this.spinner.innerHTML = `<div class="spinner"></div><span>${text}</span>`;
    this.spinner.classList.remove('video-loader-error', 'hidden');
  }

  // TEMP DEBUG HUD: a small always-on readout of what the native engine is doing
  // — libVLC state, video-output count (vout>0 means frames ARE being rendered,
  // so a black picture is a compositing problem, not a decode one), and elapsed
  // time. Remove with the diagnostic toasts before final ship.
  _updateNativeHud(partial) {
    // Disabled in production
  }

  _hideNativeHud() {
    // Disabled in production
  }

  // After committing to native, guard against a silent post-start stall (engine
  // reports playing then buffers forever with no time progress — typically the
  // server dropped the connection without libVLC raising an error). Instead of
  // surfacing an error, reconnect at the stalled position (VOD) / live edge,
  // same as the browser paths' stall watchdogs.
  _startNativeStallWatch() {
    this._stopNativeStallWatch();
    this._lastNativeProgress = Date.now();
    this._nativeStallTimer = setInterval(() => {
      if (!this._nativeActive || this._nativePaused) { this._lastNativeProgress = Date.now(); return; }
      if (Date.now() - this._lastNativeProgress > 12000) {
        this._lastNativeProgress = Date.now();
        console.warn('[player] native playback stalled (no progress 12s) — reconnecting');
        this._recoverNativeStall(false);
      }
    }, 5000);
  }

  // Native (libVLC) mid-playback reconnect — the same dropped-connection
  // mitigation as the browser watchdogs: restart the native engine at the
  // stalled position (VOD) or the live edge. Budget of 6 attempts, refunded
  // after 15s of healthy progress (see _onNativeTime), so a server that drops
  // every few minutes keeps recovering; a genuinely dead stream errors out
  // (VOD) or falls back to the browser engine (live).
  async _recoverNativeStall(fromError = false) {
    if (this._castMode || !this._streamUrl) return;
    const isVod = this._streamIsVod;
    this._nativeRecoverCount = (this._nativeRecoverCount || 0) + 1;
    this._nativeProgressSince = null;
    if (this._nativeRecoverCount > 6) {
      console.warn('[native] reconnect budget exhausted');
      this._stopNativeStallWatch();
      if (isVod) {
        this.showError('The server keeps dropping the connection. Try again in a bit, or pick another title.');
      } else {
        this._startPlayback(this._streamUrl, false); // live: try the browser engine
      }
      return;
    }
    const pos = isVod ? (this._lastNativeCur || 0) : 0;
    console.warn(`[native] ${fromError ? 'error' : 'stall'} — reconnect attempt ${this._nativeRecoverCount} at ${pos.toFixed(0)}s`);
    if (window.showToast && this._nativeRecoverCount === 1) window.showToast('Connection dropped — reconnecting…', 'info', 2500);
    this._showNativeStatus('Reconnecting…');
    this._stopNativeStallWatch();
    this._stopRectSync();
    this._nativeActive = false;
    const gen = this._streamGen;
    try { await nativeStop(); } catch (e) {}
    if (gen !== this._streamGen) return; // user switched streams meanwhile
    // Re-run the native-first chain with the resume offset; on native failure it
    // falls through to the usual fallback/error handling.
    await this._beginPlayback(this._streamUrl, isVod, pos);
  }

  _stopNativeStallWatch() {
    if (this._nativeStallTimer) { clearInterval(this._nativeStallTimer); this._nativeStallTimer = null; }
  }

  // The native video surface is composited behind the WebView; it must be sized
  // and positioned to match the on-screen player box (#video-container). Convert
  // the box's CSS rect to physical device pixels (origin = top-left of the
  // WebView) for the plugin. When the player is fullscreen the box fills the
  // viewport, so the same math yields a full-screen rect automatically.
  _computeNativeRect() {
    const el = document.getElementById('video-container');
    if (!el) return { hide: true };
    const r = el.getBoundingClientRect();
    // offsetParent === null → the player box is in a display:none view (browsing a
    // different tab while audio plays). Hide so the surface can't bleed; a real,
    // laid-out box re-shows it. In player-fs the box is fixed full-screen → full rect.
    const laidOut = el.offsetParent !== null || document.body.classList.contains('player-fs');
    if (!laidOut || r.width <= 1 || r.height <= 1) return { hide: true };
    const dpr = window.devicePixelRatio || 1;
    return {
      x: Math.round(r.left * dpr),
      y: Math.round(r.top * dpr),
      w: Math.round(r.width * dpr),
      h: Math.round(r.height * dpr),
    };
  }

  // Poll the box rect and push it to the native surface whenever it changes
  // (covers scroll, orientation, fullscreen, layout shifts) without wiring every
  // possible source. Cheap: getBoundingClientRect + a string compare.
  _startRectSync() {
    this._stopRectSync();
    this._lastRectKey = null;
    const tick = () => {
      if (!this._nativeActive) return;
      const r = this._computeNativeRect();
      // r.hide (zero-area box, or stray full-screen while not truly fullscreen)
      // → send a zero rect so the native surface hides instead of bleeding behind
      // the UI; a real boxed rect re-shows and repositions/scrolls it.
      const send = (r && !r.hide) ? { x: r.x, y: r.y, w: r.w, h: r.h } : { x: 0, y: 0, w: 0, h: 0 };
      const key = `${send.x},${send.y},${send.w},${send.h}`;
      if (key !== this._lastRectKey) {
        this._lastRectKey = key;
        nativeSetRect(send);
        this._updateNativeHud({ rect: key });
      }
      this._rectTimer = setTimeout(tick, 200);
    };
    tick();
  }

  _stopRectSync() {
    if (this._rectTimer) { clearTimeout(this._rectTimer); this._rectTimer = null; }
    this._lastRectKey = null;
  }

  // Native player time tick → drive the same seek/time UI the browser path uses.
  _onNativeTime(d) {
    const cur = d.currentTime || 0;
    const dur = d.duration || 0;
    // Any forward progress resets the post-start stall watchdog.
    if (cur > 0 && cur !== this._lastNativeCur) {
      this._lastNativeProgress = Date.now();
      this._lastNativeCur = cur;
      if (this._nativeActive) this.hideSpinner();
      this._updateNativeHud({ time: cur });
      // 15s of uninterrupted progress refunds the reconnect budget (mirrors
      // the browser watchdogs' behavior over long titles on flaky servers).
      if (this._nativeRecoverCount > 0) {
        if (!this._nativeProgressSince) this._nativeProgressSince = Date.now();
        else if (Date.now() - this._nativeProgressSince > 15000) this._nativeRecoverCount = 0;
      }
    }
    this._nativeDuration = dur;
    if (this._streamIsVod && dur > 0 && !this.isSeeking) {
      if (this.seek) {
        this.seek.value = (cur / dur) * 100;
        this.updateSeekBackground();
      }
      if (this.timeCurrent) this.timeCurrent.textContent = this.formatTime(cur);
      if (this.timeDuration) this.timeDuration.textContent = this.formatTime(dur);
      if (this.onVodProgress) this.onVodProgress(cur, dur);
    }
  }

  // A native error AFTER we'd committed to native: tear native down and fall
  // back to the browser engine for this same stream.
  _onNativeError(d) {
    if (!this._nativeActive) return; // pre-ready errors handled by nativePlay() reject
    console.warn('[player] native error mid-playback:', d && d.message);
    this._stopNativeStallWatch();
    this._stopRectSync();
    this._nativeActive = false;
    document.body.classList.remove('native-video-active');
    this._setFsDirect(false);
    nativeStop().catch(() => {});
    // For VOD, the browser path can't decode what libVLC was already playing, so
    // a fallback would only hang — reconnect native at the stalled position
    // instead (dropped connections surface as errors here too); the reconnect
    // budget surfaces the terminal error. Live can still retry browser.
    if (this._streamIsVod) {
      this._recoverNativeStall(true);
      return;
    }
    this._startPlayback(this._streamUrl, this._streamIsVod);
  }

  // Show a retrying message in the spinner area
  _showRetrying(attempt) {
    this.spinner.innerHTML =
      `<div class="spinner"></div>` +
      `<span>Retrying&hellip; (attempt ${attempt}/4)</span>`;
    this.spinner.classList.remove('video-loader-error', 'hidden');
  }

  // Schedule a full stream reload after a short delay.
  // Called when a fatal error occurs and we still have retries left.
  _retryStream() {
    if (this._castMode) return; // casting — don't restart local playback
    const MAX_RETRIES = 4;
    this._retryCount++;
    if (this._retryCount > MAX_RETRIES) {
      this.showError('Failed to load stream. Check your connection and try again.');
      return;
    }
    const attempt = this._retryCount;
    console.warn(`Stream lost — retry ${attempt}/${MAX_RETRIES} in 3 s…`);
    this._showRetrying(attempt);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      // Make sure a newer loadStream() didn't reset us in the meantime
      if (this._retryCount !== attempt) return;
      this.destroyHls();
      this.destroyMpegts();
      this.hlsNetworkRetries = 0;
      this._startPlayback(this._streamUrl, this._streamIsVod);
    }, 3000);
  }

  // Seamlessly reconnect a live stream after the provider closes the upstream
  // connection (a clean end-of-stream, not an error). Unlike _retryStream this
  // does NOT show a "Retrying…" overlay or count against the fatal-error budget,
  // because for many providers this is normal ~60s behaviour. A rapid-loop guard
  // bails to the fallback path if reconnects fire back-to-back (a stream that
  // genuinely won't play, rather than one that just needs re-opening).
  _reconnectLive() {
    if (this._castMode) return; // casting — local playback is intentionally stopped
    if (this._streamIsVod) return;

    const now = Date.now();
    if (now - (this._lastLiveReconnect || 0) < 2000) {
      this._liveReconnectFails = (this._liveReconnectFails || 0) + 1;
    } else {
      this._liveReconnectFails = 0;
    }
    this._lastLiveReconnect = now;

    // Three reconnects within ~2s of each other = the stream isn't really
    // serving video. Stop hammering the provider and fall back / error out.
    if (this._liveReconnectFails >= 3) {
      this._liveReconnectFails = 0;
      this.destroyMpegts();
      if (this.onFatalError) this.onFatalError();
      else this.showError('This stream could not be played.');
      return;
    }

    const gen = this._streamGen;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (gen !== this._streamGen) return; // user switched channels meanwhile

      // Prefer a lightweight reconnect on the existing player: unload()/load()
      // restarts the upstream connection while keeping the same MediaSource
      // attached to the <video>, so the picture freezes on the last frame for a
      // moment instead of going black. The LOADING_COMPLETE listener stays bound,
      // so the next ~60s cycle reconnects the same way. Fall back to a full
      // rebuild only if the player is gone or the light path throws.
      const p = this.mpegtsPlayer;
      if (p) {
        try {
          p.unload();
          p.load();
          p.play().catch(() => {});
          return;
        } catch (err) {
          console.warn('Light live reconnect failed, rebuilding player:', err);
        }
      }
      this.destroyMpegts();
      this._startPlayback(this._streamUrl, this._streamIsVod);
    }, 200);
  }

  _playAsHls(url, isVod) {
    if (Hls.isSupported()) {
      // Timeshift = a ~30-sec live DVR window (held in server RAM) we can scrub
      // back in, so keep the whole window as back buffer and don't snap to the
      // live edge. Plain live wants a short low-latency buffer; VOD wants
      // normal buffering so it can seek and won't stall.
      const ts = this._timeshiftActive && !isVod;
      this.hls = new Hls({
        // --- Memory limits for low-RAM devices ---
        // Keep the forward buffer short and cap total RAM used by media data.
        maxBufferLength:    ts ? 16 : (isVod ? 15 : 8),  // seconds to buffer ahead
        maxMaxBufferLength: ts ? 30 : (isVod ? 30 : 8),  // hard ceiling
        maxBufferSize:      ts ? 30 * 1000 * 1000 : 20 * 1000 * 1000,
        // Back buffer covers the whole rewind window.
        backBufferLength:   ts ? 70 : 5,
        // Timeshift chunks are 10s; the default of 3 segments would park
        // playback 30s behind live — 2 keeps latency at ~20s. Plain live also
        // targets 2 segments to sit closer to the edge.
        ...(ts ? { liveSyncDurationCount: 2 } : (!isVod ? { liveSyncDurationCount: 2 } : {})),
        // Smoothly reel back toward the live edge by briefly speeding up (up to
        // 1.5x) instead of a visible hard seek whenever we drift behind. Live
        // only — VOD must play at 1x.
        ...(!isVod ? { maxLiveSyncPlaybackRate: 1.5 } : {}),
        // Plain live only: if stalls drift playback more than ~6 segments
        // behind, let hls.js hard-seek FORWARD to re-sync. Never set for
        // timeshift — it would fight deliberate DVR pause/rewind.
        ...(!isVod && !ts ? { liveMaxLatencyDurationCount: 6 } : {}),
        enableWorker: true,
        lowLatencyMode: !isVod && !ts
      });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);
      // Live/timeshift silent-stall recovery is handled by _startLiveStallWatch
      // (armed in _startPlayback for every live engine, not just hls.js).

      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.video.play().catch(err => console.log('Playback auto-play blocked:', err));
        this.hideSpinner();
      });

      this.hls.on(Hls.Events.ERROR, (event, data) => {
        if (!data.fatal) return;

        const httpCode = data.response && data.response.code;
        const isManifestFailure =
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
          data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;

        if (isManifestFailure || httpCode === 403 || httpCode === 401 || httpCode === 404) {
          console.error('HLS manifest could not be loaded:', data);
          this.destroyHls();
          
          if (isVod) {
            this._handleVodPlaybackFallback({ code: 4, message: `HLS manifest failed (HTTP ${httpCode || 'unknown'})` });
          } else {
            this.showError(this.describeStreamError(httpCode));
          }
          return;
        }

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.warn('Fatal HLS network error, scheduling retry…', data);
            this.destroyHls();
            this._retryStream();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR: {
            // Throttle recovery. Unthrottled recoverMediaError() on a stream the
            // browser can't decode loops forever — each call flushes the buffer
            // (black blip) and pegs the main thread (UI goes unresponsive). Try
            // recover, then recover+swapAudioCodec, then give up.
            const t = Date.now();
            const r = this._hlsMediaRecover || { n: 0, at: 0 };
            if (t - r.at > 8000) r.n = 0;   // a calm gap = treat the next as fresh
            r.at = t; r.n++;
            this._hlsMediaRecover = r;
            if (r.n === 1) {
              console.warn('HLS media error — recovering…');
              this.hls.recoverMediaError();
            } else if (r.n === 2) {
              console.warn('HLS media error again — swapping audio codec…');
              this.hls.swapAudioCodec();
              this.hls.recoverMediaError();
            } else {
              console.error('HLS media-error recovery is thrashing.');
              this.destroyHls();
              // Live: reconnect (reload the playlist) rather than killing the
              // stream — the server keeps the timeshift buffer alive.
              if (isVod) this._handleVodPlaybackFallback({ code: 3, message: 'HLS media error' });
              else this._retryStream();
            }
            break;
          }
          default:
            console.error('Fatal HLS error:', data);
            this.destroyHls();
            if (isVod) {
              this._handleVodPlaybackFallback({ code: 4, message: 'HLS playback error' });
            } else {
              this._retryStream(); // live: reconnect rather than give up
            }
            break;
        }
      });
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari / Capacitor WebView)
      this.video.src = url;
      this.video.addEventListener('loadedmetadata', () => {
        this.video.play().catch(err => console.log('Playback blocked:', err));
        this.hideSpinner();
      });
    } else {
      this.hideSpinner();
      alert('Your browser does not support HLS streaming.');
    }
  }

  _playAsMpegTs(url, isVod) {
    if (mpegts.getFeatureList().mseLivePlayback) {
      this.mpegtsPlayer = mpegts.createPlayer({
        type: 'mpegts',
        isLive: !isVod,
        url: url
      }, {
        enableStashBuffer:              isVod,
        stashInitialSize:               128,
        autoCleanupSourceBuffer:        true,
        autoCleanupMinBackwardDuration: 10,
        autoCleanupMaxBackwardDuration: 20,
        // --- live latency control ---
        // Without chasing, the live buffer quietly grows and the picture drifts
        // further behind the edge the longer a channel stays open. Chasing seeks
        // forward whenever we fall more than ~1.5s behind, holding us near live.
        liveBufferLatencyChasing:         !isVod,
        liveBufferLatencyChasingOnPaused: false,
        liveBufferLatencyMaxLatency:      1.5,  // seconds behind edge before chasing
        liveBufferLatencyMinRemain:       0.3,  // don't chase past this safety margin
      });
      this.mpegtsPlayer.attachMediaElement(this.video);
      this.mpegtsPlayer.load();
      this.mpegtsPlayer.play().catch(err => console.log('MPEG-TS autoplay blocked:', err));

      this.mpegtsPlayer.on(mpegts.Events.ERROR, (type, detail, info) => {
        console.error('MPEG-TS player error:', type, detail, info);
        this.hideSpinner();
        
        if (isVod) {
          this.destroyMpegts();
          this._handleVodPlaybackFallback({ code: 4, message: 'mpegts.js failed' });
        } else if (this._retryCount < 4) {
          console.warn('MPEG-TS error — scheduling retry…');
          this.destroyMpegts();
          this._retryStream();
        } else {
          if (!isVod && this.onFatalError) this.onFatalError();
          else this.showError('This stream could not be played.');
        }
      });

      if (!isVod) {
        this.mpegtsPlayer.on(mpegts.Events.LOADING_COMPLETE, () => {
          console.warn('Live stream ended (provider closed connection) — reconnecting…');
          this._reconnectLive();
        });
      }

      this.video.onloadedmetadata = () => {
        this.hideSpinner();
      };
    } else {
      // Fallback direct source assignment
      this.video.src = url;
      this.video.load();
      this.video.play()
        .then(() => this.hideSpinner())
        .catch(err => {
          console.error('Native MPEG-TS direct play failed:', err);
          this.hideSpinner();
          alert('Your browser does not support MPEG-TS stream playback.');
        });
    }
  }

  // Internal: set up the HLS / MPEG-TS / native player for a given URL.
  // Called by loadStream(), _retryStream() and _reconnectLive().
  _startPlayback(url, isVod) {
    // Watch for silent mid-playback stalls (server dropping the connection
    // without an error event) and auto-reconnect. Separate watchdogs: VOD
    // resumes at the stalled file position, live rejoins the stream edge.
    if (isVod) {
      this._stopLiveStallWatch();
      this._startVodStallWatch();
    } else {
      this._stopVodStallWatch();
      this._startLiveStallWatch();
    }

    // VOD (movies / series episodes) is a single on-demand file addressed by its
    // real container extension, so match strictly on the file type. Live streams
    // keep the looser matching (and the /live/ path heuristic).
    let isHls, isMpegTs;
    if (isVod) {
      isHls = /\.m3u8(\?|$)/i.test(url);
      isMpegTs = /\.ts(\?|$)/i.test(url);
    } else {
      isHls = url.includes('.m3u8') || url.includes('m3u8');
      isMpegTs = url.includes('.ts') || url.includes('ts') || (url.includes('/live/') && !url.includes('.m3u8'));
    }

    if (isHls) {
      this._triedHlsOriginal = true;
      this._triedHlsRewritten = true;
      if (isVod) this._armVodWatchdog();
      this._playAsHls(url, isVod);
    } else if (isMpegTs) {
      this._triedMpegtsOriginal = true;
      this._triedMpegtsRewritten = true;
      if (isVod) this._armVodWatchdog();
      this._playAsMpegTs(url, isVod);
    } else {
      // Direct VOD media files (mp4, mkv, etc.)
      this.video.src = url;
      this.video.load();

      // Set a 7.5-second timeout to detect silent stalls/blocks (e.g. mixed content blocks)
      clearTimeout(this._vodLoadTimeout);
      this._vodLoadTimeout = setTimeout(() => {
        if (this.video.readyState < 1 && this.hasStream && !this.hls && !this.mpegtsPlayer) {
          console.warn('Direct VOD playback timed out (readyState < 1) — triggering fallback.');
          this._handleVodPlaybackFallback({ code: 4, message: 'Playback load timeout' });
        }
      }, 7500);

      this.video.play()
        .then(() => {
          this.hideSpinner();
        })
        .catch(err => {
          console.error('Error playing direct VOD stream:', err);
          if (err.name === 'NotAllowedError') {
            clearTimeout(this._vodLoadTimeout);
            this.hideSpinner();
            this.video.pause();
          }
        });
    }
  }

  // Arm a watchdog for a browser VOD stage (mpegts/hls/direct). If the stage
  // neither starts playing nor fires its own error within the window, advance the
  // fallback chain. Without this, an engine that stalls silently on an unsupported
  // container (e.g. mpegts.js chewing on an MKV) leaves the spinner up forever.
  // The existing 'playing'/'loadedmetadata' listeners clear this timer on success.
  _armVodWatchdog(ms = 12000) {
    clearTimeout(this._vodLoadTimeout);
    this._vodLoadTimeout = setTimeout(() => {
      if (!this.hasStream) return;
      if (this.spinner && this.spinner.classList.contains('hidden')) return; // already playing
      console.warn('VOD stage watchdog fired — advancing fallback chain.');
      this._handleVodPlaybackFallback({ code: 4, message: 'stage load timeout' });
    }, ms);
  }

  // Common VOD fallback format router
  _handleVodPlaybackFallback(err) {
    clearTimeout(this._vodLoadTimeout);
    const url = this._streamUrl;
    const isVod = this._streamIsVod;
    // Re-arm the watchdog for whichever stage we're about to try next so a silent
    // stall can't park the spinner. The terminal error branch clears it below.
    this._armVodWatchdog();

    if (!this._triedMpegtsOriginal) {
      this._triedMpegtsOriginal = true;
      console.warn(`Falling back to mpegts.js with original URL: ${url}`);
      this.destroyHls();
      this.destroyMpegts();
      this._playAsMpegTs(url, isVod);
    } else if (!this._triedHlsOriginal) {
      this._triedHlsOriginal = true;
      console.warn(`Falling back to hls.js with original URL: ${url}`);
      this.destroyHls();
      this.destroyMpegts();
      this._playAsHls(url, isVod);
    } else if (!this._triedMpegtsRewritten) {
      this._triedMpegtsRewritten = true;
      const fallbackUrl = replaceUrlExtension(url, 'ts');
      console.warn(`Falling back to mpegts.js with .ts rewritten URL: ${fallbackUrl}`);
      this.destroyHls();
      this.destroyMpegts();
      this._playAsMpegTs(fallbackUrl, isVod);
    } else if (!this._triedHlsRewritten) {
      this._triedHlsRewritten = true;
      const fallbackUrl = replaceUrlExtension(url, 'm3u8');
      console.warn(`Falling back to hls.js with .m3u8 rewritten URL: ${fallbackUrl}`);
      this.destroyHls();
      this.destroyMpegts();
      this._playAsHls(fallbackUrl, isVod);
    } else if (!this._triedExtensionless) {
      this._triedExtensionless = true;
      const fallbackUrl = removeUrlExtension(url);
      if (fallbackUrl !== url) {
        console.warn(`Falling back to direct play of extensionless URL: ${fallbackUrl}`);
        this.destroyHls();
        this.destroyMpegts();
        this.video.src = fallbackUrl;
        this.video.load();
        this.video.play()
          .then(() => this.hideSpinner())
          .catch(playErr => {
            console.error('Extensionless fallback play failed:', playErr);
          });
      } else {
        // Skip extensionless direct fallback if URL was already extensionless
        this._handleVodPlaybackFallback(err);
      }
    } else if (this._isElectron() && !this._triedTranscodeAudio) {
      // Desktop: browser couldn't play it (likely HEVC + E-AC3). Hand the stream
      // to the server's ffmpeg transcode — first audio-only (cheap: copy video,
      // E-AC3 -> AAC), which works whenever the GPU can HW-decode the HEVC video.
      this._triedTranscodeAudio = true;
      this._playViaTranscode('audio');
    } else if (this._isElectron() && !this._triedTranscodeFull) {
      // Audio-only still failed -> the video codec isn't decodable here either,
      // so transcode video too (H.264). Heavier, but plays on any GPU.
      this._triedTranscodeFull = true;
      this._playViaTranscode('full');
    } else {
      // Exhausted every browser fallback — stop the watchdog and report.
      clearTimeout(this._vodLoadTimeout);
      let errMsg = 'This VOD stream could not be played.';
      if (err) {
        if (err.code === 3) errMsg = 'Video decoding failed (unsupported format).';
        else if (err.code === 4) errMsg = 'VOD stream format not supported or 404 not found.';
        if (err.message) errMsg += ` (${err.message})`;
      }

      this.showError(errMsg);
    }
  }

  // True only inside the Electron desktop app (preload exposes appHost/electronCast).
  // Web and Android never transcode (Android uses libVLC; web has no ffmpeg host).
  _isElectron() {
    return !!(window.appHost || window.electronCast);
  }

  // Build the /api/transcode URL from a resolved playback URL. The resolved URL is
  // either /api/proxy?url=<target> or a direct provider URL; we hand the real
  // target to ffmpeg so it streams from the source, not back through our proxy.
  _buildTranscodeUrl(url, mode = 'audio', start = 0) {
    const target = this._transcodeTarget(url);
    const params = new URLSearchParams({ url: target, mode });
    if (start > 0) params.set('start', String(Math.floor(start)));
    if (this._deinterlaceOn()) params.set('deint', '1');
    return `/api/transcode?${params.toString()}`;
  }

  // Deinterlace-to-60fps preference (desktop ffmpeg paths only).
  _deinterlaceOn() {
    try { return localStorage.getItem('deinterlace') === '1'; } catch (e) { return false; }
  }

  // Reflect the deinterlace toggle state on the control-bar button.
  reflectDeinterlace(on) {
    if (this.deintBtn) this.deintBtn.classList.toggle('active', !!on);
  }

  // Re-run the current VOD/catch-up stream so a changed ffmpeg option (e.g.
  // deinterlace) takes effect, preserving the playback position. Live channels
  // are re-tuned from main.js (they must restart the timeshift segmenter).
  reloadCurrent() {
    if (!this.hasStream || !this._streamUrl || !this._streamIsVod) return false;
    let resume = 0;
    try { resume = (typeof this._currentTime === 'function') ? this._currentTime() : (this.video?.currentTime || 0); } catch (e) {}
    const name = this.currentChannelName || '';
    const epg = this.epgTitleEl ? this.epgTitleEl.textContent : '';
    this.loadStream(this._streamUrl, name, this._currentLogo || '', epg, true, resume || 0);
    return true;
  }

  // Resolve the real upstream URL ffmpeg should fetch (unwrap our /api/proxy, make
  // relative URLs absolute). Shared by transcode + probe.
  _transcodeTarget(url) {
    let target = url;
    try {
      if (/\/api\/proxy/.test(url)) {
        const m = url.match(/[?&]url=([^&]+)/);
        if (m) target = decodeURIComponent(m[1]);
      } else if (!/^https?:\/\//i.test(url)) {
        target = new URL(url, window.location.origin).href;
      }
    } catch (e) {}
    return target;
  }

  // Total duration (s) the seek bar should use: the probed real length for a
  // transcoded stream (the piped fMP4's own duration is just the buffered amount),
  // else the element's duration.
  _totalDuration() {
    if (this._transcodeActive && this._transcodeDuration > 0) return this._transcodeDuration;
    // Timeshift: the seek bar spans the DVR window (up to 30 min) hls.js exposes
    // as the seekable range, not the element's duration (which is Infinity here).
    if (this._timeshiftActive) { const w = this._tsWindow(); return w ? w.end - w.start : NaN; }
    return this.video.duration;
  }

  // Logical current time (s): a transcoded segment plays from 0 but represents
  // _transcodeOffset into the title, so add the offset back.
  _currentTime() {
    if (this._transcodeActive) return this._transcodeOffset + (this.video.currentTime || 0);
    if (this._timeshiftActive) { const w = this._tsWindow(); return w ? (this.video.currentTime || 0) - w.start : 0; }
    return this.video.currentTime;
  }

  // The current timeshift seekable window {start,end} in element time, or null.
  _tsWindow() {
    const s = this.video.seekable;
    if (s && s.length) return { start: s.start(0), end: s.end(s.length - 1) };
    return null;
  }

  // Skip relative seconds (+forward / -back). Clamps to the seekable bounds:
  // the timeshift DVR window for live, or [0, duration] for VOD. Transcoded VOD
  // isn't byte-seekable, so it re-requests at the new offset.
  skipBy(secs) {
    if (this._transcodeActive) {
      const d = this._totalDuration();
      let t = this._currentTime() + secs;
      if (isFinite(d)) t = Math.min(d, t);
      this._seekTranscode(Math.max(0, t));
      return;
    }
    let lo = 0, hi = Infinity;
    if (this._timeshiftActive) {
      const w = this._tsWindow();
      if (w) { lo = w.start; hi = w.end; }
      // Skipping back is a deliberate exit from live — disarm the drift guard.
      if (secs < 0) this._wantLive = false;
    } else {
      const d = this._totalDuration();
      if (isFinite(d)) hi = d;
    }
    this._expectSeek = true;
    try { this.video.currentTime = Math.max(lo, Math.min(hi, (this.video.currentTime || 0) + secs)); } catch (e) {}
  }

  // Jump to the live edge of the timeshift buffer. Don't park on the very edge:
  // the last segment is still being written, so seeking to seekable.end starves
  // the forward buffer and freezes. Target hls.js's own liveSyncPosition (a few
  // seconds back, where it keeps appending) — that's "live" and keeps advancing.
  goLive() {
    let target = null;
    if (this.hls && typeof this.hls.liveSyncPosition === 'number' && isFinite(this.hls.liveSyncPosition)) {
      target = this.hls.liveSyncPosition;
    } else {
      const w = this._tsWindow();
      if (w) target = Math.max(w.start, w.end - 10); // ~1.5 segments behind the edge
    }
    if (target == null) return;
    this._wantLive = true; // re-arm the drift guard
    this._expectSeek = true; // our own seek — don't trip the anti-jump guard
    try { this.video.currentTime = target; this.video.play(); } catch (e) {}
  }

  // Scrub on a transcoded stream: re-request the transcode starting at `target`
  // seconds (server applies -ss), tracking the new base offset.
  _seekTranscode(target) {
    this._transcodeOffset = Math.max(0, Math.floor(target));
    const turl = this._buildTranscodeUrl(this._streamUrl, this._transcodeMode || 'audio', this._transcodeOffset);
    this.showSpinner();
    this.destroyHls();
    this.destroyMpegts();
    this._armVodWatchdog(25000);
    this.video.src = turl;
    this.video.load();
    this.video.play()
      .then(() => this.hideSpinner())
      .catch((err) => { console.error('Transcode seek play failed:', err); });
  }

  // Play the current VOD via the server ffmpeg transcode (desktop only). The
  // result is a fragmented MP4 the <video> element plays directly. Transcode
  // start-up is slower than a direct open, so the watchdog window is widened.
  // NOTE: a piped transcode isn't byte-range seekable; scrubbing would need a
  // re-request with ?start= (TODO). Resume offset is honored via pendingSeek.
  _playViaTranscode(mode) {
    const start = this._streamIsVod ? (this.pendingSeek || 0) : 0;
    this._transcodeActive = true;
    this._transcodeMode = mode;
    this._transcodeOffset = start;
    this.pendingSeek = 0; // the transcode itself starts at `start`; don't re-seek the element
    const turl = this._buildTranscodeUrl(this._streamUrl, mode, start);
    console.warn(`Falling back to server transcode (${mode}): ${turl}`);
    // Probe the real total duration once so the seek bar is scrubbable (the piped
    // fMP4 reports only the buffered length). Best-effort; bar falls back if it fails.
    if (!this._transcodeDuration && this._streamIsVod) {
      const target = this._transcodeTarget(this._streamUrl);
      fetch(`/api/probe?url=${encodeURIComponent(target)}`)
        .then((r) => r.json())
        .then((d) => {
          if (d && d.duration > 0 && this._transcodeActive) {
            this._transcodeDuration = d.duration;
            if (this._refreshTimeUi) this._refreshTimeUi();
          }
        })
        .catch(() => {});
    }
    this.destroyHls();
    this.destroyMpegts();
    this._armVodWatchdog(25000);
    this.video.src = turl;
    this.video.load();
    this.video.play()
      .then(() => this.hideSpinner())
      .catch((err) => {
        console.error(`Transcode (${mode}) play failed:`, err);
      });
  }

  // Briefly surface the current channel (logo, name, time/date) plus a short
  // lineup — 1 previous, the current (highlighted), and the next 2 — as a
  // semi-transparent OSD banner, then auto-hide after a few seconds.
  showChannelInfo(currentChannel, channels = [], currentIndex = -1) {
    if (!this.channelInfoBanner) return;

    const name = currentChannel?.name || 'Live Channel';
    const logo = currentChannel?.stream_icon || '';

    // Header: prominent current channel + clock
    if (logo) {
      this.cibLogoImg.src = proxifyImage(logo);
      this.cibLogo.style.display = '';
    } else {
      this.cibLogo.style.display = 'none';
    }
    const qBadge = getQualityBadgeHtml(name);
    this.cibName.innerHTML = `
      <span class="cib-name-text">${name}</span>
      ${qBadge}
    `;

    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const date = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    this.cibDatetime.textContent = `${time} · ${date}`;

    // Lineup list: previous (-1), current (0, highlighted), next (+1, +2)
    if (this.cibList) {
      this.cibList.innerHTML = '';
      const hasList = Array.isArray(channels) && currentIndex >= 0;
      if (hasList) {
        [-1, 0, 1, 2].forEach((offset) => {
          const ch = channels[currentIndex + offset];
          if (!ch) return;
          const row = document.createElement('div');
          row.className = 'cib-row' + (offset === 0 ? ' current' : '');
          const chLogo = proxifyImage(ch.stream_icon || '');
          const qBadgeLineup = getQualityBadgeHtml(ch.name);
          // What's airing on this channel right now (cached EPG, best-effort).
          let nowTitle = '—';
          try {
            const nn = window.epgGridInstance?.getNowNext?.(ch.stream_id);
            if (nn && nn.current && nn.current.title) nowTitle = nn.current.title;
          } catch (e) { /* no EPG — keep the dash */ }
          row.innerHTML = `
            <span class="cib-row-logo">${chLogo ? `<img src="${chLogo}" alt="">` : '<i data-lucide="tv"></i>'}</span>
            <span class="cib-row-name" style="display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 8px;">
              <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;">${ch.name || 'Channel'}</span>
              ${qBadgeLineup}
              <span class="cib-row-now">${nowTitle}</span>
            </span>
          `;
          this.cibList.appendChild(row);
        });
        if (typeof lucide !== 'undefined') lucide.createIcons({ scope: this.cibList });
        this.cibList.style.display = '';
      } else {
        this.cibList.style.display = 'none';
      }
    }

    this.channelInfoBanner.classList.add('visible');
    clearTimeout(this.channelInfoTimeout);
    this.channelInfoTimeout = setTimeout(() => {
      this.channelInfoBanner.classList.remove('visible');
    }, 4000);
  }

  // Cable-box style one-line "flip bar" along the bottom: shows the current
  // program and what's up next for the tuned channel, then hides after 20s.
  showProgramGuide(current, next) {
    if (!this.nowNextBar) return;

    const fmt = (p) => {
      if (!p) return null;
      const start = new Date(parseInt(p.start_timestamp) * 1000);
      const end = new Date(parseInt(p.end_timestamp) * 1000);
      const t = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const valid = !isNaN(start) && !isNaN(end) && p.start_timestamp;
      return { time: valid ? `${t(start)} - ${t(end)}` : '', title: p.title || 'No Title' };
    };

    const nowP = fmt(current);
    if (nowP) {
      this.nnbNowTime.textContent = nowP.time;
      this.nnbNowTitle.textContent = nowP.title;
    } else {
      this.nnbNowTime.textContent = '';
      this.nnbNowTitle.textContent = 'No schedule information';
    }

    const nextP = fmt(next);
    if (nextP) {
      this.nnbNextTime.textContent = nextP.time;
      this.nnbNextTitle.textContent = nextP.title;
      this.nnbNext.style.display = '';
      this.nnbSep.style.display = '';
    } else {
      this.nnbNext.style.display = 'none';
      this.nnbSep.style.display = 'none';
    }

    this.nowNextBar.classList.add('visible');
    clearTimeout(this.nowNextTimeout);
    this.nowNextTimeout = setTimeout(() => {
      this.nowNextBar.classList.remove('visible');
    }, 20000);
  }

  formatTime(sec) {
    if (!sec || !isFinite(sec)) return '0:00';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Set the play/pause button icon (used by both the browser <video> events and
  // the native player, which has no DOM media events).
  _setPlayPauseIcon(playing) {
    if (!this.playPauseBtn) return;
    const name = playing ? 'pause' : 'play';
    this.playPauseBtn.innerHTML = `<i class="play-icon" data-lucide="${name}"></i>`;
    try { lucide.createIcons({ attrs: { class: 'play-icon' }, nameList: [name], scope: this.playPauseBtn }); } catch (e) {}
  }

  togglePlay() {
    // While casting, the control bar drives the TV, not the local <video>.
    if (this._castMode && window.castControls && window.castControls.isActive()) {
      window.castControls.playPause();
      return;
    }
    if (this._nativeActive) {
      if (this._nativePaused) { nativePlayCtl(); this._nativePaused = false; this._setPlayPauseIcon(true); }
      else { nativePauseCtl(); this._nativePaused = true; this._setPlayPauseIcon(false); }
      return;
    }
    if (this.video.paused) {
      this.video.play().catch(e => console.log(e));
    } else {
      this.video.pause();
    }
  }

  stop() {
    // While casting, the bar's Stop ends the cast (and returns to local playback).
    if (this._castMode && window.castControls && window.castControls.isActive()) {
      window.castControls.stop();
      return;
    }
    // Playback is ending — let the phone screen sleep normally again.
    setScreenAwake(false);
    clearTimeout(this._vodLoadTimeout);
    this._stopNativeStallWatch();
    this._stopVodStallWatch();
    this._stopLiveStallWatch();
    this._stopRectSync();
    this._hideNativeHud();
    this.stopFpsTracker();
    this.hasStream = false; // no active stream → no orientation fullscreen
    if (this._nativeActive) {
      nativeStop().catch(() => {});
      this._nativeActive = false;
      document.body.classList.remove('native-video-active');
    }
    this._setFsDirect(false);
    this._transcodeActive = false;
    this._transcodeOffset = 0;
    this._transcodeDuration = 0;
    this._transcodeMode = null;
    if (this._timeshiftActive) {
      this._timeshiftActive = false;
      document.body.classList.remove('timeshift-active', 'ts-at-live');
      try { fetch('/api/timeshift/stop'); } catch (e) {}   // free the ffmpeg buffer
    }
    document.body.classList.remove('player-session');
    // Release any fullscreen orientation lock so the app returns to free rotation.
    if (Capacitor.isNativePlatform()) { try { ScreenOrientation.unlock().catch(() => {}); } catch (e) {} }
    this.video.pause();
    this.destroyHls();
    this.destroyMpegts();
    this.video.src = '';
    this.video.load();
    this.currentChannelName = '';
    this.channelNameEl.textContent = 'No Channel Selected';
    this.epgTitleEl.textContent = 'Select a channel from the list to start watching';
    if (this.fpsIndicatorEl) {
      this.fpsIndicatorEl.textContent = '';
    }
    if (this.qualityBadgeEl) {
      this.qualityBadgeEl.textContent = '';
      this.qualityBadgeEl.classList.remove('visible');
    }
    this.watermark.classList.add('hidden');
    this.hideSpinner();
    if (this.idleScreen) this.idleScreen.classList.remove('hidden'); // back to idle
    this.setSeriesMode(false);
    
    if (Capacitor.isNativePlatform()) {
      try {
        const PipPlugin = registerPlugin('PipPlugin');
        PipPlugin.setPlaybackState({ active: false });
      } catch (e) {
        console.error('Failed to notify stop state:', e);
      }
    }
  }

  startFpsTracker() {
    this.stopFpsTracker();
    
    let lastTime = performance.now();
    let lastFrames = 0;
    
    this.fpsInterval = setInterval(() => {
      if (this.video.paused || this.video.ended) return;
      
      const now = performance.now();
      let frames = 0;
      
      if (typeof this.video.getVideoPlaybackQuality === 'function') {
        const quality = this.video.getVideoPlaybackQuality();
        frames = quality.totalVideoFrames;
      } else if (this.video.webkitDecodedFrameCount) {
        frames = this.video.webkitDecodedFrameCount;
      } else if (this.video.mozDecodedFrames) {
        frames = this.video.mozDecodedFrames;
      }
      
      if (frames > 0 && lastFrames > 0) {
        const elapsed = (now - lastTime) / 1000;
        const deltaFrames = frames - lastFrames;
        const fps = Math.round(deltaFrames / elapsed);
        
        if (fps > 0 && fps < 120) {
          this.currentFps = fps;
          this.updateQualityIndicator();
        }
      }
      
      lastTime = now;
      lastFrames = frames;
    }, 1000);
  }
  
  stopFpsTracker() {
    if (this.fpsInterval) {
      clearInterval(this.fpsInterval);
      this.fpsInterval = null;
    }
  }

  updateQualityIndicator() {
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    
    if (!width || !height) {
      if (this.fpsIndicatorEl) this.fpsIndicatorEl.textContent = 'Loading...';
      return;
    }
    
    let quality = 'SD';
    if (height >= 2160 || width >= 3840) {
      quality = '4K';
    } else if (height >= 1080 || width >= 1920) {
      quality = 'FHD';
    } else if (height >= 720 || width >= 1280) {
      quality = 'HD';
    }
    
    const fps = this.currentFps || 30;
    const label = `${quality} | ${fps} FPS`;
    if (this.fpsIndicatorEl) {
      this.fpsIndicatorEl.textContent = label;
    }
    if (this.qualityBadgeEl) {
      this.qualityBadgeEl.textContent = label;
      this.qualityBadgeEl.classList.add('visible');
    }
    
    if (this.channelNameEl && this.currentChannelName) {
      const qBadge = `<span class="quality-badge badge-${quality.toLowerCase()}">${quality}</span>`;
      this.channelNameEl.innerHTML = `
        <span class="player-channel-name-text">${this.currentChannelName}</span>
        ${qBadge}
      `;
    }
  }

  destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }

  // --- VOD stall auto-recovery ---------------------------------------------
  // Some Xtream servers drop the HTTP connection mid-file on VOD. The browser
  // plays out whatever it already buffered, then stops silently — no 'error'
  // event fires because a prematurely closed download isn't a media error. A
  // manual seek "fixes" it because seeking issues a fresh range request on a
  // new connection. This watchdog automates that: when playback stalls with
  // no progress, micro-seek into unbuffered space (forces a new range
  // request); if that doesn't take, fully reload the source and resume at the
  // stalled position via the existing pendingSeek machinery.
  _startVodStallWatch() {
    this._stopVodStallWatch();
    this._vodRecoverCount = 0;
    let last = -1;
    let lastChange = Date.now();
    let progressSince = null; // wall-clock start of the current healthy stretch
    this._vodStallTimer = setInterval(() => {
      const v = this.video;
      if (!this.hasStream || !this._streamIsVod || this._castMode || this._nativeActive ||
          v.paused || v.seeking || v.ended) {
        last = v.currentTime; lastChange = Date.now(); progressSince = null;
        return;
      }
      const t = v.currentTime;
      if (Math.abs(t - last) > 0.2) {
        last = t; lastChange = Date.now();
        if (progressSince == null) progressSince = Date.now();
        // 15s of uninterrupted playback earns the recovery budget back, so a
        // server that drops every few minutes over a 2h movie keeps recovering.
        else if (this._vodRecoverCount > 0 && Date.now() - progressSince > 15000) this._vodRecoverCount = 0;
        return;
      }
      progressSince = null;
      // Don't fight a legitimate end-of-file. Under a piped transcode the
      // element's duration is just the buffered length (it ends wherever the
      // pipe died), so use the probed real duration instead.
      const dur = (this._transcodeActive && this._transcodeDuration > 0)
        ? this._transcodeDuration - this._transcodeOffset
        : v.duration;
      if (isFinite(dur) && dur > 0 && dur - t < 1.5) return;
      if (Date.now() - lastChange > 6000) {
        lastChange = Date.now();
        this._recoverVodStall();
      }
    }, 2000);
  }

  _stopVodStallWatch() {
    if (this._vodStallTimer) { clearInterval(this._vodStallTimer); this._vodStallTimer = null; }
  }

  // One reconnect attempt. Returns false once the retry budget is spent (the
  // caller may then surface a terminal error).
  _recoverVodStall(forceReload = false) {
    this._vodRecoverCount = (this._vodRecoverCount || 0) + 1;
    if (this._vodRecoverCount > 6) {
      console.warn('[vod] stall recovery budget exhausted');
      this._stopVodStallWatch();
      this.showError('The server keeps dropping the connection. Try again in a bit, or pick another title.');
      return false;
    }
    const pos = this.video.currentTime;
    console.warn(`[vod] stalled at ${pos.toFixed(1)}s — reconnect attempt ${this._vodRecoverCount}`);
    if (window.showToast && this._vodRecoverCount === 1) window.showToast('Connection dropped — reconnecting…', 'info', 2500);

    if (this._transcodeActive) {
      // Piped ffmpeg transcode: not range-seekable, so neither a micro-seek
      // nor a plain reload can resume it. Re-request the transcode at the
      // stalled absolute position (?start= → server-side -ss) — fresh ffmpeg,
      // fresh upstream connection, picks up where it died.
      this._seekTranscode(this._transcodeOffset + pos);
      return true;
    }
    if (this.hls) {
      // hls.js: kick the loader — it re-requests the stalled fragment on a
      // fresh connection.
      try { this.hls.stopLoad(); this.hls.startLoad(pos); this.video.play().catch(() => {}); } catch (e) {}
      return true;
    }
    if (!forceReload && !this.mpegtsPlayer && this._vodRecoverCount <= 2) {
      // Direct file: a tiny forward seek lands in unbuffered space, forcing
      // the browser to open a fresh range request — exactly what a manual
      // seek does. Costs 0.1s of content, keeps A/V state intact.
      this._expectSeek = true;
      try {
        this.video.currentTime = pos + 0.1;
        this.video.play().catch(() => {});
      } catch (e) {}
      return true;
    }
    // Micro-seek didn't take (or the element errored, or mpegts is driving):
    // full reload of the same URL, resuming at the stalled position.
    const url = this._streamUrl;
    if (!url) return false;
    this.pendingSeek = pos; // applied on loadedmetadata/canplay
    if (this.mpegtsPlayer) {
      // .ts VOD: the element can't play raw TS directly — rebuild the engine.
      this.destroyMpegts();
      this._playAsMpegTs(url, true);
    } else {
      this.video.src = url;
      this.video.load();
      this.video.play().catch(() => {});
    }
    return true;
  }

  // --- Live stall auto-recovery ----------------------------------------------
  // Watchdog for ALL live engines (hls.js incl. timeshift, mpegts.js, direct):
  // if currentTime stops advancing for >8s while we're meant to be playing, the
  // connection dropped without the engine declaring an error (server closed the
  // socket silently, segmenter blipped, half-open TCP…). Recover seamlessly
  // first — mpegts unload()/load() keeps the last frame on screen, an hls.js
  // loader kick re-requests the stalled fragment — and only escalate to the
  // visible "Retrying…" full rebuild (_retryStream) if the soft path doesn't
  // restore progress. Soft attempts reset once playback advances again, so a
  // provider that drops every few minutes keeps reconnecting indefinitely;
  // _retryStream's 4-strike budget (refunded on 'playing') still catches
  // genuinely dead streams.
  _startLiveStallWatch() {
    this._stopLiveStallWatch();
    let last = -1;
    let lastChange = Date.now();
    let softTries = 0; // seamless attempts within the current stall episode
    this._liveStallTimer = setInterval(() => {
      const v = this.video;
      if (!this.hasStream || this._streamIsVod || this._castMode || this._nativeActive ||
          v.paused || v.seeking) {
        last = v.currentTime; lastChange = Date.now();
        return;
      }
      const t = v.currentTime;
      if (Math.abs(t - last) > 0.25) { last = t; lastChange = Date.now(); softTries = 0; return; }
      if (Date.now() - lastChange > 8000) {
        lastChange = Date.now();
        softTries++;
        if (this.mpegtsPlayer && softTries <= 2) {
          console.warn('[live] stalled >8s — seamless mpegts reconnect…');
          this._reconnectLive(); // light unload()/load(), rapid-loop guarded
        } else if (this.hls && softTries <= 2) {
          console.warn('[live] HLS stalled >8s — kicking loader…');
          try {
            this.hls.stopLoad();
            this.hls.startLoad();
            v.play().catch(() => {});
          } catch (e) { this._retryStream(); }
        } else {
          console.warn('[live] stalled — full retry…');
          this._retryStream();
        }
      }
    }, 3000);
  }

  _stopLiveStallWatch() {
    if (this._liveStallTimer) { clearInterval(this._liveStallTimer); this._liveStallTimer = null; }
  }

  destroyMpegts() {
    if (this.mpegtsPlayer) {
      try {
        this.mpegtsPlayer.pause();
        this.mpegtsPlayer.unload();
        this.mpegtsPlayer.detachMediaElement();
        this.mpegtsPlayer.destroy();
      } catch (err) {
        console.warn('Error destroying mpegts player:', err);
      }
      this.mpegtsPlayer = null;
    }
  }

  // --- Casting: stop local streaming while the TV plays it, then resume --------
  // Tears down the local decoders (stops the duplicate network stream) but keeps
  // _streamUrl so playback can resume when casting ends. _castMode blocks the
  // auto-retry/reconnect timers from restarting local playback meanwhile.
  stopLocalPlayback() {
    this._castMode = true;
    clearTimeout(this._retryTimer);
    clearTimeout(this._reconnectTimer);
    this._stopNativeStallWatch();
    this._stopVodStallWatch();
    this._stopLiveStallWatch();
    this._stopRectSync();
    if (this._nativeActive) {
      nativeStop().catch(() => {});
      this._nativeActive = false;
      document.body.classList.remove('native-video-active');
    }
    this.destroyHls();
    this.destroyMpegts();
    try { this.video.pause(); } catch (e) {}
    this.hideSpinner();
    const overlay = document.getElementById('player-cast-overlay');
    if (overlay) overlay.classList.remove('hidden');
    // Keep the control bar visible + interactive over the cast backdrop (CSS uses
    // body.casting to force the otherwise hover-only overlay on).
    document.body.classList.add('casting');
    // The TV is playing now — let the phone screen sleep.
    setScreenAwake(false);
  }

  resumeLocalPlayback() {
    this._castMode = false;
    document.body.classList.remove('casting');
    const overlay = document.getElementById('player-cast-overlay');
    if (overlay) overlay.classList.add('hidden');
    if (this._streamUrl) {
      setScreenAwake(true); // back to local playback — keep the screen on
      this._startPlayback(this._streamUrl, this._streamIsVod);
    }
  }

  setCastOverlayDevice(name) {
    const el = document.getElementById('cast-overlay-device');
    if (el) el.textContent = name || '';
  }

  updateVolumeIcon() {
    let iconName = 'volume-2';
    if (this.video.muted || this.video.volume === 0) {
      iconName = 'volume-x';
      this.volumeSlider.value = 0;
    } else if (this.video.volume < 0.4) {
      iconName = 'volume-1';
      this.volumeSlider.value = this.video.volume;
    } else {
      this.volumeSlider.value = this.video.volume;
    }
    
    this.volumeBtn.innerHTML = `<i data-lucide="${iconName}"></i>`;
    lucide.createIcons({ scope: this.volumeBtn });
  }

  // Native uses an explicit CSS state (body.player-fs) for immersive fullscreen —
  // NOT the browser Fullscreen API (which broke the behind-WebView surface). The
  // surface rect-syncs to #video-container, so toggling the class (which makes the
  // box fixed/full-screen) full-screens the video. Web/desktop keep the real API.
  // Fullscreen is DERIVED FROM ORIENTATION on native: player-fs (immersive) exists
  // only in landscape, never in portrait. Portrait is always the docked/boxed view.
  // The fullscreen button doesn't set fullscreen directly — it rotates the device
  // (orientation lock), and this fn (called on every orientation change + on play)
  // applies the matching state. TV is exempt (handled by remote, no rotation).
  _applyFsForOrientation() {
    if (!Capacitor.isNativePlatform() || this._isTv()) return;
    const isL = this.isLandscape();
    const wasL = this._wasLandscape;
    this._wasLandscape = isL;

    if (!isL) {
      // Portrait: always force exit fullscreen
      this._setFsDirect(false);
    } else if (isL && !wasL && this.hasStream) {
      // Transitioned from portrait to landscape while playing: auto-enter fullscreen
      this._setFsDirect(true);
    }
  }

  // TV (landscape-only, no portrait): fullscreen is a direct CSS toggle — boxed ↔
  // immersive, both landscape, NO rotation. (Phones use _rotateForFs instead.)
  _setFsDirect(on) {
    document.body.classList.toggle('player-fs', !!on);
    this._lastRectKey = null;
    if (this.fullscreenBtn) {
      this.fullscreenBtn.innerHTML = on ? '<i data-lucide="minimize"></i>' : '<i data-lucide="maximize"></i>';
      if (typeof lucide !== 'undefined') {
        try { lucide.createIcons({ scope: this.fullscreenBtn }); } catch (e) {}
      }
    }
  }

  // Rotate the device to drive fullscreen: portrait→landscape enters, landscape→
  // portrait exits. player-fs itself is applied by _applyFsForOrientation once the
  // orientation actually changes, so fullscreen never appears in portrait.
  _rotateForFs(toLandscape) {
    try {
      ScreenOrientation.lock({ orientation: toLandscape ? 'landscape' : 'portrait' }).catch(() => {});
    } catch (e) {}
    // Re-derive fullscreen after the rotation settles, in case the resize/media
    // events don't fire (some WebViews) — guarantees the state catches up.
    [120, 400, 800].forEach(ms => setTimeout(() => this._applyFsForOrientation(), ms));
  }

  toggleFullscreen() {
    if (Capacitor.isNativePlatform()) {
      if (this._isTv()) {
        // TV (no portrait): pure CSS toggle, stays landscape.
        this._setFsDirect(!document.body.classList.contains('player-fs'));
      } else {
        if (this.isLandscape()) {
          const nextOn = !document.body.classList.contains('player-fs');
          this._setFsDirect(nextOn);
          if (!nextOn) {
            // Toggled fullscreen OFF in landscape: unlock orientation so they can rotate physically
            try { ScreenOrientation.unlock().catch(() => {}); } catch (e) {}
          } else {
            // Toggled fullscreen ON in landscape: lock orientation to landscape
            try { ScreenOrientation.lock({ orientation: 'landscape' }).catch(() => {}); } catch (e) {}
          }
        } else {
          // In portrait, toggle enters fullscreen by rotating to landscape
          this._rotateForFs(true);
        }
      }
      return;
    }
    const container = this.video.parentElement;
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(err => {
        console.error(`Error entering fullscreen: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  }

  enterFullscreen() {
    if (Capacitor.isNativePlatform()) {
      if (this._isTv()) {
        this._setFsDirect(true);      // TV: direct, stays landscape
      } else {
        if (this.isLandscape()) {
          this._setFsDirect(true);
          try { ScreenOrientation.lock({ orientation: 'landscape' }).catch(() => {}); } catch (e) {}
        } else {
          this._rotateForFs(true);                   // phone/tablet: rotate→landscape
        }
      }
      return;
    }
    const container = this.video.parentElement;
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(err => {
        console.warn(`Error entering fullscreen: ${err.message}`);
      });
    }
  }

  toggleCaptions() {
    if (this.hls) {
      const tracks = this.video.textTracks;
      if (tracks.length > 0) {
        // Toggle the first track between showing and disabled
        const track = tracks[0];
        track.mode = track.mode === 'showing' ? 'disabled' : 'showing';
        this.ccBtn.style.color = track.mode === 'showing' ? '#06b6d4' : '#fff';
      }
    }
  }

  // Collect the audio + subtitle tracks available from whichever engine is
  // active (hls.js, or the native <video> for mpegts/direct play).
  getTrackMenu() {
    const audio = [];
    const subs = [{ id: 'sub:off', label: 'Off', active: false }];

    if (this.hls) {
      (this.hls.audioTracks || []).forEach((t, i) => {
        audio.push({ id: 'audio:' + i, label: t.name || t.lang || `Audio ${i + 1}`, active: i === this.hls.audioTrack });
      });
      (this.hls.subtitleTracks || []).forEach((t, i) => {
        subs.push({ id: 'sub:' + i, label: t.name || t.lang || `Subtitle ${i + 1}`, active: i === this.hls.subtitleTrack });
      });
      subs[0].active = this.hls.subtitleTrack === -1;
    } else {
      const at = this.video.audioTracks;
      if (at && at.length) {
        for (let i = 0; i < at.length; i++) {
          audio.push({ id: 'audio:' + i, label: at[i].label || at[i].language || `Audio ${i + 1}`, active: !!at[i].enabled });
        }
      }
      const tt = this.video.textTracks;
      let anySub = false;
      if (tt && tt.length) {
        for (let i = 0; i < tt.length; i++) {
          const showing = tt[i].mode === 'showing';
          if (showing) anySub = true;
          subs.push({ id: 'sub:' + i, label: tt[i].label || tt[i].language || `Subtitle ${i + 1}`, active: showing });
        }
      }
      subs[0].active = !anySub;
    }

    return { audio, subs };
  }

  // Apply a track chosen from the menu: "audio:<i>", "sub:<i>" or "sub:off".
  applyTrack(id) {
    const [kind, idxStr] = String(id).split(':');
    if (kind === 'audio') {
      const i = parseInt(idxStr, 10);
      if (this.hls) {
        this.hls.audioTrack = i;
      } else if (this.video.audioTracks) {
        for (let j = 0; j < this.video.audioTracks.length; j++) this.video.audioTracks[j].enabled = (j === i);
      }
    } else if (kind === 'sub') {
      if (idxStr === 'off') {
        if (this.hls) this.hls.subtitleTrack = -1;
        const tt = this.video.textTracks;
        if (tt) for (let j = 0; j < tt.length; j++) tt[j].mode = 'disabled';
        this.ccBtn.style.color = '#fff';
      } else {
        const i = parseInt(idxStr, 10);
        if (this.hls) { this.hls.subtitleTrack = i; this.hls.subtitleDisplay = true; }
        const tt = this.video.textTracks;
        if (tt) for (let j = 0; j < tt.length; j++) tt[j].mode = (j === i) ? 'showing' : 'disabled';
        this.ccBtn.style.color = '#06b6d4';
      }
    }
  }

  // Attach an externally fetched subtitle (VTT text) as a <track> and show it.
  // Used by the OpenSubtitles search in the Audio & Subtitles menu.
  addExternalSubtitle(vttText, label = 'Online subtitle') {
    if (this._extSubUrl) { try { URL.revokeObjectURL(this._extSubUrl); } catch (e) {} }
    // Remove any previous online track so repeated searches don't pile up.
    this.video.querySelectorAll('track[data-external-sub]').forEach(t => t.remove());
    this._extSubUrl = URL.createObjectURL(new Blob([vttText], { type: 'text/vtt' }));
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = label;
    track.srclang = 'en';
    track.src = this._extSubUrl;
    track.setAttribute('data-external-sub', '1');
    this.video.appendChild(track);
    const tt = this.video.textTracks;
    for (let j = 0; j < tt.length; j++) tt[j].mode = (j === tt.length - 1) ? 'showing' : 'disabled';
    if (this.ccBtn) this.ccBtn.style.color = '#06b6d4';
  }

  async togglePiP() {
    if (Capacitor.isNativePlatform()) {
      try {
        const PipPlugin = registerPlugin('PipPlugin');
        const res = await PipPlugin.enterPiP();
        // PiP can't be granted via a runtime dialog. If the OS refused to enter
        // (the special "Picture-in-picture" access is off for this app), send the
        // user straight to the settings screen where they can enable it. We don't
        // use window.confirm() here because it doesn't reliably render in the
        // Android WebView and would silently dead-end.
        if (res && res.needsPermission) {
          await PipPlugin.openPiPSettings();
        }
      } catch (err) {
        console.error('Failed to enter Android PiP:', err);
      }
    } else {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (this.video.readyState >= 1) {
          await this.video.requestPictureInPicture();
        }
      } catch (err) {
        console.error('Failed to toggle web PiP:', err);
      }
    }
  }

  showControlsTemporarily() {
    clearTimeout(this._controlsVisHideTimer);
    this.controls.style.visibility = 'visible';
    this.controls.style.opacity = '1';
    this.watermark.style.opacity = '0';
    // The always-on quality/FPS badge also overlaps the video and blocks the
    // hardware overlay, so it fades out with the controls (restored here).
    if (this.qualityBadgeEl) {
      this.qualityBadgeEl.style.visibility = 'visible';
      this.qualityBadgeEl.style.opacity = '1';
    }
    document.body.style.cursor = 'default';

    clearTimeout(this.controlsTimeout);
    this.controlsTimeout = setTimeout(() => {
      this.hideControls();
    }, 3000);
  }

  hideControls() {
    // During native playback the <video> element is always "paused" (libVLC is
    // the one playing), so the old guard kept controls up forever — treat an
    // active, non-paused native stream as playing too.
    const nativePlaying = this._nativeActive && !this._nativePaused;
    if (!nativePlaying && this.video.paused) return; // Don't hide controls if paused
    this.controls.style.opacity = '0';
    // Watermark used to fade IN when controls hid; it overlaps the video and
    // would block the hardware overlay, so keep it hidden during playback too.
    this.watermark.style.opacity = '0';
    if (this.qualityBadgeEl) this.qualityBadgeEl.style.opacity = '0';

    // After the fade, drop the overlay, quality badge and watermark out of
    // compositing entirely so nothing covers the <video>. A layer over the video
    // (even at opacity:0) keeps Chromium from promoting the video to a hardware
    // overlay, which disables driver Video Super Resolution (VSR).
    // visibility:hidden removes it as a paint/compositing layer;
    // showControlsTemporarily() restores the controls + badge.
    clearTimeout(this._controlsVisHideTimer);
    this._controlsVisHideTimer = setTimeout(() => {
      this.controls.style.visibility = 'hidden';
      if (this.qualityBadgeEl) this.qualityBadgeEl.style.visibility = 'hidden';
      this.watermark.style.visibility = 'hidden';
    }, 350);

    // Hide cursor in fullscreen when controls hide
    if (document.fullscreenElement) {
      document.body.style.cursor = 'none';
    }
  }

  showSpinner() {
    // Restore the loading state (spinner + text) and show it.
    this.spinner.innerHTML = '<div class="spinner"></div><span>Loading Stream...</span>';
    this.spinner.classList.remove('video-loader-error');
    this.spinner.classList.remove('hidden');
  }

  hideSpinner() {
    this.spinner.classList.add('hidden');
  }

  // Build a human-readable explanation from the HTTP status the provider returned.
  describeStreamError(httpCode) {
    if (httpCode === 403) {
      return 'Stream blocked by the provider (HTTP 403). Many IPTV providers only allow playback from home/mobile networks, not from web servers. Try the mobile or desktop app.';
    }
    if (httpCode === 401) {
      return 'Not authorized for this stream (HTTP 401). Your subscription may not include this channel.';
    }
    if (httpCode === 404) {
      return 'Stream not found (HTTP 404). This channel may be offline or unavailable in this format.';
    }
    return 'Could not load this stream. The provider may be blocking playback from this network, or the channel is offline.';
  }

  // Replace the spinner with a non-spinning error message in the player area.
  showError(message) {
    this.hideSpinner();
    this.spinner.innerHTML =
      `<div class="video-error-icon"><i data-lucide="alert-triangle"></i></div>` +
      `<span class="video-error-text">${message}</span>`;
    this.spinner.classList.add('video-loader-error');
    this.spinner.classList.remove('hidden');
    try {
      if (window.lucide) lucide.createIcons({ scope: this.spinner });
    } catch (e) {}
  }

  updateSeekBackground() {
    if (!this.seek) return;
    const pct = this.seek.value || 0;
    this.seek.style.background = `linear-gradient(to right, var(--accent-red, #ef4444) 0%, var(--accent-red, #ef4444) ${pct}%, rgba(255, 255, 255, 0.22) ${pct}%, rgba(255, 255, 255, 0.22) 100%)`;
  }

  // Release all resources held by this player instance.
  // --- Upscaler (FSR-1-style WebGL enhancement over the <video>) --------------
  // Lazily built the first time it's turned on. Engine-agnostic: it reads frames
  // straight off the <video>, so it keeps working across channel/engine switches.
  _ensureUpscaler() {
    if (this._upscaler) return this._upscaler;
    const container = document.getElementById('video-container') || this.video.parentElement;
    this._upscaler = new Upscaler(this.video, container);
    if (!this._upscaler.supported) console.warn('Upscaler: WebGL2 unavailable — staying on raw video.');
    return this._upscaler;
  }

  // Turn the upscaler on/off. Returns the new state. Persists the choice.
  toggleUpscaler() {
    const up = this._ensureUpscaler();
    if (!up.supported) return false;
    const on = up.toggle();
    try { localStorage.setItem('upscaler_enabled', on ? '1' : '0'); } catch (e) {}
    return on;
  }

  setUpscalerSharpness(v) {
    const up = this._ensureUpscaler();
    up.setSharpness(v);
    try { localStorage.setItem('upscaler_sharpness', String(v)); } catch (e) {}
  }

  // Apply the saved preference (call once after the player is set up).
  restoreUpscalerPref() {
    try {
      const s = parseFloat(localStorage.getItem('upscaler_sharpness'));
      if (!isNaN(s)) this._ensureUpscaler().setSharpness(s);
      if (localStorage.getItem('upscaler_enabled') === '1') this._ensureUpscaler().enable();
    } catch (e) {}
  }

  // Call this if the player element is ever removed from the DOM.
  destroy() {
    if (this._upscaler) { this._upscaler.destroy(); this._upscaler = null; }
    clearTimeout(this._vodLoadTimeout);
    if (this._onFullscreenChange) {
      document.removeEventListener('fullscreenchange', this._onFullscreenChange);
      this._onFullscreenChange = null;
    }
    // Cancel any pending retry timer
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this.destroyHls();
    this.destroyMpegts();
    if (this.video) {
      this.video.src = '';
      this.video.load();
    }
  }
}
export default VideoPlayer;
