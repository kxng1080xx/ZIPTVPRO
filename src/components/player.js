import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';

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

export class VideoPlayer {
  constructor() {
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
    this.watermark = document.getElementById('player-watermark');
    this.watermarkImg = document.getElementById('watermark-img');
    this.pipBtn = document.getElementById('player-pip-btn');
    this.infoBtn = document.getElementById('player-info-btn');
    this.fpsIndicatorEl = document.getElementById('player-fps-indicator');
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
      lucide.createIcons({ scope: this.fullscreenBtn });
    };
    document.addEventListener('fullscreenchange', this._onFullscreenChange);

    // CC Toggle
    this.ccBtn.addEventListener('click', () => this.toggleCaptions());

    // Info button toggle channel details panel
    if (this.infoBtn) {
      this.infoBtn.addEventListener('click', () => {
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
        const d = this.video.duration;
        if (d && isFinite(d)) this.video.currentTime = (this.seek.value / 100) * d;
        this.isSeeking = false;
      });
    }

    // VOD back button → exit the VOD player and return to the catalog
    if (this.backBtn) {
      this.backBtn.addEventListener('click', () => {
        if (this.onExitVod) this.onExitVod();
      });
    }

    // Controls visibility timeout
    const container = this.video.parentElement;
    container.addEventListener('mousemove', () => this.showControlsTemporarily());
    container.addEventListener('mouseleave', () => this.hideControls());

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
    this.video.addEventListener('loadedmetadata', () => this.updateQualityIndicator());
    this.video.addEventListener('resize', () => this.updateQualityIndicator());
    this.video.addEventListener('play', () => this.startFpsTracker());
    this.video.addEventListener('playing', () => {
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

    // Orientation-aware fullscreen (phones): while a stream is active, rotating
    // to landscape enters fullscreen; rotating back to portrait exits it. Auto-
    // fullscreen on play only happens in landscape (see autoFullscreen()).
    try {
      this._landscapeMql = window.matchMedia('(orientation: landscape)');
      const onOrient = (e) => {
        if (!this.hasStream) return;
        if (e.matches) this.enterFullscreen();
        else this.exitFullscreen();
      };
      if (this._landscapeMql.addEventListener) this._landscapeMql.addEventListener('change', onOrient);
      else if (this._landscapeMql.addListener) this._landscapeMql.addListener(onOrient); // legacy WebView
    } catch (e) {}
  }

  isLandscape() {
    try { return window.matchMedia('(orientation: landscape)').matches; } catch (e) { return true; }
  }

  // Auto-fullscreen on play — but only in landscape. In portrait we stay inline
  // so the user can keep browsing; rotating to landscape fullscreens it.
  autoFullscreen() {
    if (this.isLandscape()) this.enterFullscreen();
  }

  exitFullscreen() {
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

    if (logo) {
      this.watermarkImg.src = logo;
      this.watermark.classList.remove('hidden');
    } else {
      this.watermark.classList.add('hidden');
    }

    // Reset retry state for the new stream
    clearTimeout(this._retryTimer);
    clearTimeout(this._reconnectTimer);
    this._retryCount = 0;
    this._streamUrl = url;
    this._streamIsVod = isVod;
    this._triedMpegts = false;
    this._triedHls = false;
    // Bumped on every new stream so a pending live reconnect for an old
    // channel cancels itself once the user has switched away.
    this._streamGen = (this._streamGen || 0) + 1;

    // Stop existing streams
    this.destroyHls();
    this.destroyMpegts();
    this.hlsNetworkRetries = 0;

    this._startPlayback(url, isVod);
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
          
          if (isVod && !this._triedMpegts) {
            this._triedMpegts = true;
            console.warn('HLS load failed — falling back to mpegts.js for VOD...');
            this._playAsMpegTs(url, isVod);
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
            this.showError('This stream could not be played.');
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
      // Retry on native video error
      this.video.addEventListener('error', () => {
        console.warn('Native HLS video error, scheduling retry…');
        this._retryStream();
      }, { once: true });
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
        
        if (isVod && !this._triedHls) {
          this._triedHls = true;
          console.warn('mpegts.js failed — falling back to hls.js for VOD...');
          this.destroyMpegts();
          this._playAsHls(url, isVod);
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
      this._triedHls = true;
      this._playAsHls(url, isVod);
    } else if (isMpegTs) {
      this._triedMpegts = true;
      this._playAsMpegTs(url, isVod);
    } else {
      // Direct VOD media files (mp4, mkv, etc.)
      this.video.src = url;
      
      const onError = (e) => {
        const err = this.video.error;
        console.warn('Direct VOD playback failed natively:', err);
        
        this.video.removeEventListener('error', onError);
        
        if (!this._triedMpegts) {
          this._triedMpegts = true;
          console.warn('Falling back to mpegts.js for direct VOD stream...');
          this.destroyHls();
          this.destroyMpegts();
          this._playAsMpegTs(url, isVod);
        } else if (!this._triedHls) {
          this._triedHls = true;
          console.warn('Falling back to hls.js for direct VOD stream...');
          this.destroyHls();
          this.destroyMpegts();
          this._playAsHls(url, isVod);
        } else {
          let errMsg = 'This VOD stream could not be played.';
          if (err) {
            if (err.code === 3) errMsg = 'Video decoding failed (unsupported format).';
            else if (err.code === 4) errMsg = 'VOD stream format not supported or 404 not found.';
            if (err.message) errMsg += ` (${err.message})`;
          }
          this.showError(errMsg);
        }
      };
      this.video.addEventListener('error', onError);

      this.video.load();
      this.video.play()
        .then(() => {
          this.hideSpinner();
          this.video.removeEventListener('error', onError);
        })
        .catch(err => {
          console.error('Error playing direct VOD stream:', err);
          if (err.name === 'NotAllowedError') {
            this.hideSpinner();
            this.video.pause();
            this.video.removeEventListener('error', onError);
          }
        });
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
      this.cibLogoImg.src = logo;
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
          const chLogo = ch.stream_icon || '';
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

  togglePlay() {
    if (this.video.paused) {
      this.video.play().catch(e => console.log(e));
    } else {
      this.video.pause();
    }
  }

  stop() {
    this.stopFpsTracker();
    this.hasStream = false; // no active stream → no orientation fullscreen
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
    this.watermark.classList.add('hidden');
    this.hideSpinner();
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
    if (this.fpsIndicatorEl) {
      this.fpsIndicatorEl.textContent = `${quality} | ${fps} FPS`;
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

  toggleFullscreen() {
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
    if (this.video.paused) return; // Don't hide controls if paused
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
