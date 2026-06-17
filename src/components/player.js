import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';

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

    this.hls = null;
    this.mpegtsPlayer = null;
    this.controlsTimeout = null;
    this.onPrevChannelCallback = null;
    this.onNextChannelCallback = null;
    this.onVideoEnded = null;
    this.isVod = false;

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

    // Listen to fullscreenchange to lock screen to landscape in fullscreen mode
    document.addEventListener('fullscreenchange', () => {
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
    });

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
        if (this.isSeeking) return;
        const d = this.video.duration;
        if (d && isFinite(d)) {
          this.seek.value = (this.video.currentTime / d) * 100;
          this.timeCurrent.textContent = this.formatTime(this.video.currentTime);
        }
      });
      const refreshDuration = () => {
        const d = this.video.duration;
        this.timeDuration.textContent = (d && isFinite(d)) ? this.formatTime(d) : '';
      };
      this.video.addEventListener('loadedmetadata', refreshDuration);
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

    // Handle video end event (auto-play episodes)
    this.video.addEventListener('ended', () => {
      if (this.onVideoEnded) this.onVideoEnded();
    });
  }

  setOnPrevChannel(callback) {
    this.onPrevChannelCallback = callback;
  }

  setOnNextChannel(callback) {
    this.onNextChannelCallback = callback;
  }

  loadStream(url, name, logo, currentEpg = 'No schedule available', isVod = false) {
    this.isVod = isVod;
    this.showSpinner();
    this.channelNameEl.textContent = name || 'Live Channel';
    this.epgTitleEl.textContent = currentEpg;

    if (logo) {
      this.watermarkImg.src = logo;
      this.watermark.classList.remove('hidden');
    } else {
      this.watermark.classList.add('hidden');
    }

    // Stop existing streams
    this.destroyHls();
    this.destroyMpegts();
    this.hlsNetworkRetries = 0;

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
      if (Hls.isSupported()) {
        // Live wants a short, low-latency buffer; VOD wants normal buffering so
        // it can seek and won't stall.
        this.hls = new Hls({
          maxMaxBufferLength: isVod ? 60 : 10,
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
          // If we can't even load/parse the manifest, retrying won't help —
          // this is almost always the provider rejecting the request (403),
          // a bad URL (404), or auth (401). Surface it instead of spinning.
          const isManifestFailure =
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
            data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;

          if (isManifestFailure || httpCode === 403 || httpCode === 401 || httpCode === 404) {
            console.error('HLS manifest could not be loaded:', data);
            this.destroyHls();
            this.showError(this.describeStreamError(httpCode));
            return;
          }

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              this.hlsNetworkRetries++;
              if (this.hlsNetworkRetries > 4) {
                console.error('HLS network error limit reached, giving up.');
                this.destroyHls();
                this.showError(this.describeStreamError(httpCode));
              } else {
                console.warn(`Fatal network error in HLS, recovery attempt ${this.hlsNetworkRetries}...`);
                this.hls.startLoad();
              }
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
        // Native HLS (Safari)
        this.video.src = url;
        this.video.addEventListener('loadedmetadata', () => {
          this.video.play().catch(err => console.log('Playback blocked:', err));
          this.hideSpinner();
        });
      } else {
        this.hideSpinner();
        alert('Your browser does not support HLS streaming.');
      }
    } else if (isMpegTs) {
      // MPEG-TS Playback via mpegts.js (low latency stream)
      if (mpegts.getFeatureList().mseLivePlayback) {
        this.mpegtsPlayer = mpegts.createPlayer({
          type: 'mpegts',
          isLive: !isVod,
          url: url
        }, {
          enableStashBuffer: isVod,
          liveBufferLatencyChaser: !isVod
        });
        this.mpegtsPlayer.attachMediaElement(this.video);
        this.mpegtsPlayer.load();
        this.mpegtsPlayer.play().catch(err => console.log('MPEG-TS autoplay blocked:', err));

        this.mpegtsPlayer.on(mpegts.Events.ERROR, (type, detail, info) => {
          console.error('MPEG-TS player error:', type, detail, info);
          this.hideSpinner();
          // Live .ts failed — let the app fall back to the m3u8 backup.
          if (!isVod && this.onFatalError) this.onFatalError();
        });

        // Set video tag loaded metadata callback
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
    } else {
      // Direct VOD media files (mp4, mkv, etc.)
      this.video.src = url;
      this.video.load();
      this.video.play()
        .then(() => this.hideSpinner())
        .catch(err => {
          console.error('Error playing direct VOD stream:', err);
          this.hideSpinner();
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
    this.cibName.textContent = name;

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
          row.innerHTML = `
            <span class="cib-row-logo">${chLogo ? `<img src="${chLogo}" alt="">` : '<i data-lucide="tv"></i>'}</span>
            <span class="cib-row-name">${ch.name || 'Channel'}</span>
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
    this.video.pause();
    this.destroyHls();
    this.destroyMpegts();
    this.video.src = '';
    this.video.load();
    this.channelNameEl.textContent = 'No Channel Selected';
    this.epgTitleEl.textContent = 'Select a channel from the list to start watching';
    this.watermark.classList.add('hidden');
    this.hideSpinner();
    
    if (Capacitor.isNativePlatform()) {
      try {
        const PipPlugin = registerPlugin('PipPlugin');
        PipPlugin.setPlaybackState({ active: false });
      } catch (e) {
        console.error('Failed to notify stop state:', e);
      }
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
}
export default VideoPlayer;
