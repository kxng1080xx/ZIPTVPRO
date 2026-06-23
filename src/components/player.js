import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { proxifyImage } from './xtream-api.js';
import {
  isNativeAvailable, nativeBackend, nativePlay, nativeStop, nativePlayCtl, nativePauseCtl,
  nativeSeek, nativeSetVolume, nativeSetRect
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
    this.vodTitleTag = document.getElementById('player-vod-title');
    this.onExitVod = null;
    this.isSeeking = false;
    this.onFatalError = null; // live: invoked when the primary (.ts) stream fails
    this.onVodProgress = null; // VOD/series: (currentTime, duration) for Continue Watching
    this.pendingSeek = 0; // resume position to seek to once metadata loads
    this.isVodActive = false;

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
      this.updateVolumeIcon();
    });

    this.volumeBtn.addEventListener('click', () => {
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
      this.stopBtn.addEventListener('click', () => this.stop());
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
          const d = this.video.duration;
          if (d && isFinite(d)) {
            this.seek.value = (this.video.currentTime / d) * 100;
            this.timeCurrent.textContent = this.formatTime(this.video.currentTime);
          }
        }
        // Report progress for Continue Watching (VOD / series only)
        if (this.isVodActive && this.onVodProgress) {
          this.onVodProgress(this.video.currentTime, this.video.duration);
        }
      });
      const refreshDuration = () => {
        const d = this.video.duration;
        this.timeDuration.textContent = (d && isFinite(d)) ? this.formatTime(d) : '';
      };
      const seekToResume = () => {
        if (this.pendingSeek > 0 && isFinite(this.video.duration)) {
          try { this.video.currentTime = this.pendingSeek; } catch (e) {}
          this.pendingSeek = 0;
        }
      };
      this.video.addEventListener('loadedmetadata', refreshDuration);
      this.video.addEventListener('loadedmetadata', seekToResume);
      this.video.addEventListener('canplay', seekToResume);
      this.video.addEventListener('durationchange', refreshDuration);
      this.seek.addEventListener('input', () => { this.isSeeking = true; });
      this.seek.addEventListener('change', () => {
        if (this._nativeActive) {
          const d = this._nativeDuration || 0;
          if (d > 0) nativeSeek((this.seek.value / 100) * d);
          this.isSeeking = false;
          return;
        }
        const d = this.video.duration;
        if (d && isFinite(d)) this.video.currentTime = (this.seek.value / 100) * d;
        this.isSeeking = false;
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

    this.video.addEventListener('pause', () => {
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
    });
    this.video.addEventListener('leavepictureinpicture', () => {
      document.body.classList.remove('pip-mode-active');
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
    });
    this.video.addEventListener('pause', () => this.stopFpsTracker());
    this.video.addEventListener('ended', () => {
      this.stopFpsTracker();
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
          } else {
            let errMsg = 'VOD playback interrupted.';
            if (err) {
              if (err.code === 3) errMsg = 'Video decoding failed.';
              else if (err.code === 4) errMsg = 'VOD stream connection lost.';
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
  }

  isLandscape() {
    try { return window.matchMedia('(orientation: landscape)').matches; } catch (e) { return true; }
  }

  // Auto-fullscreen on play — but only in landscape. In portrait we stay inline
  // so the user can keep browsing; rotating to landscape fullscreens it.
  _isTv() { return document.body.classList.contains('tv-layout'); }

  autoFullscreen() {
    // Native phone: starting playback in landscape goes straight to immersive. TV
    // never auto-fullscreens (stays boxed: player + grid). Web keeps its behavior.
    if (Capacitor.isNativePlatform()) {
      if (this._isTv()) return;
      const isL = this.isLandscape();
      this._wasLandscape = isL;
      this._setFsDirect(isL);
      return;
    }
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

  loadStream(url, name, logo, currentEpg = 'No schedule available', isVod = false, resumeTime = 0) {
    this.isVod = isVod;
    this.isVodActive = isVod;
    this.hasStream = true; // gates orientation-driven fullscreen
    this.pendingSeek = isVod ? (resumeTime || 0) : 0;
    if (this.idleScreen) this.idleScreen.classList.add('hidden'); // a stream is starting
    // Mark an active playback session from the moment of tap (loading → playing), so
    // the VOD player box appears immediately with the spinner — not only once libVLC
    // reaches "ready" (native-video-active). Removed in stop().
    document.body.classList.add('player-session');
    this.showSpinner();
    this.currentChannelName = name || 'Live Channel';
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
    this._retryCount = 0;
    this._streamUrl = url;
    this._streamIsVod = isVod;
    this._triedMpegtsOriginal = false;
    this._triedHlsOriginal = false;
    this._triedMpegtsRewritten = false;
    this._triedHlsRewritten = false;
    this._triedExtensionless = false;
    // Bumped on every new stream so a pending live reconnect for an old
    // channel cancels itself once the user has switched away.
    this._streamGen = (this._streamGen || 0) + 1;

    // Stop existing streams
    this.destroyHls();
    this.destroyMpegts();
    this.hlsNetworkRetries = 0;

    this._beginPlayback(url, isVod, this.pendingSeek);
  }

  // Native-first playback: try the device's native player (ExoPlayer on Android,
  // mpv on Electron) which decodes E-AC3/AC3, HEVC and MKV that the browser
  // <video> can't. On any failure/timeout, fall back to the browser engine so
  // native issues never regress working playback. Web has no native layer.
  async _beginPlayback(url, isVod, resumeTime = 0) {
    this._nativeActive = false;
    this._nativeSawLife = false;
    if (isNativeAvailable() && !this._castMode) {
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
  // reports playing then buffers forever with no time progress). If no timeupdate
  // advances for ~25s, surface an error rather than spinning indefinitely.
  _startNativeStallWatch() {
    this._stopNativeStallWatch();
    this._lastNativeProgress = Date.now();
    this._nativeStallTimer = setInterval(() => {
      if (!this._nativeActive || this._nativePaused) { this._lastNativeProgress = Date.now(); return; }
      if (Date.now() - this._lastNativeProgress > 25000) {
        this._stopNativeStallWatch();
        console.warn('[player] native playback stalled (no progress 25s)');
        if (window.showToast) window.showToast('Playback stalled', 'error', 4000);
        this.showError('Playback stalled. The connection may have dropped or the device cannot keep up with this stream. Try again or pick another title.');
      }
    }, 5000);
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
    }
    this._nativeDuration = dur;
    if (this._streamIsVod && dur > 0 && !this.isSeeking) {
      if (this.seek) this.seek.value = (cur / dur) * 100;
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
    // a fallback would only hang — surface the error. Live can still retry browser.
    if (this._streamIsVod) {
      this.showError('Playback stopped unexpectedly. Please try again or pick another title.');
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
      // Live wants a short, low-latency buffer; VOD wants normal buffering so
      // it can seek and won't stall.
      this.hls = new Hls({
        // --- Memory limits for low-RAM devices ---
        // Keep the forward buffer short and cap total RAM used by media data.
        maxBufferLength:    isVod ? 15 : 8,    // seconds to buffer ahead
        maxMaxBufferLength: isVod ? 30 : 8,    // hard ceiling
        maxBufferSize:      20 * 1000 * 1000,  // 20 MB cap
        backBufferLength:   5,                 // free segments >5 s behind playhead
        enableWorker: true,
        lowLatencyMode: !isVod
      });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);

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
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.warn('Fatal media error in HLS, attempting recovery...');
            this.hls.recoverMediaError();
            break;
          default:
            console.error('Fatal HLS error, stopping stream:', data);
            this.destroyHls();
            if (isVod) {
              this._handleVodPlaybackFallback({ code: 4, message: 'HLS playback error' });
            } else {
              this.showError('This stream could not be played.');
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
          row.innerHTML = `
            <span class="cib-row-logo">${chLogo ? `<img src="${chLogo}" alt="">` : '<i data-lucide="tv"></i>'}</span>
            <span class="cib-row-name" style="display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 8px;">
              <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;">${ch.name || 'Channel'}</span>
              ${qBadgeLineup}
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
    clearTimeout(this._vodLoadTimeout);
    this._stopNativeStallWatch();
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
  }

  resumeLocalPlayback() {
    this._castMode = false;
    const overlay = document.getElementById('player-cast-overlay');
    if (overlay) overlay.classList.add('hidden');
    if (this._streamUrl) {
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
    this.controls.style.opacity = '1';
    this.watermark.style.opacity = '0';
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
    this.watermark.style.opacity = '0.4';
    
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

  // Release all resources held by this player instance.
  // Call this if the player element is ever removed from the DOM.
  destroy() {
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
