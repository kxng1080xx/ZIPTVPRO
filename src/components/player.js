import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';

export class VideoPlayer {
  constructor() {
    this.video = document.getElementById('main-video-player');
    this.controls = document.getElementById('player-controls');
    this.playPauseBtn = document.getElementById('player-play-pause-btn');
    this.stopBtn = document.getElementById('player-stop-btn');
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

    this.hls = null;
    this.mpegtsPlayer = null;
    this.controlsTimeout = null;
    this.onPrevChannelCallback = null;
    this.onNextChannelCallback = null;

    this.initEventListeners();
  }

  initEventListeners() {
    // Play / Pause click
    this.playPauseBtn.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('click', () => this.togglePlay());

    // Stop click
    this.stopBtn.addEventListener('click', () => this.stop());

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
  }

  setOnPrevChannel(callback) {
    this.onPrevChannelCallback = callback;
  }

  setOnNextChannel(callback) {
    this.onNextChannelCallback = callback;
  }

  loadStream(url, name, logo, currentEpg = 'No schedule available') {
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

    const isHls = url.includes('.m3u8') || url.includes('m3u8');
    const isMpegTs = url.includes('.ts') || url.includes('ts') || (url.includes('/live/') && !url.includes('.m3u8'));

    if (isHls) {
      if (Hls.isSupported()) {
        this.hls = new Hls({
          maxMaxBufferLength: 10,
          enableWorker: true,
          lowLatencyMode: true
        });
        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);
        
        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
          this.video.play().catch(err => console.log('Playback auto-play blocked:', err));
          this.hideSpinner();
        });

        this.hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.warn('Fatal network error in HLS, attempting recovery...');
                this.hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.warn('Fatal media error in HLS, attempting recovery...');
                this.hls.recoverMediaError();
                break;
              default:
                console.error('Fatal HLS error, stopping stream:', data);
                this.stop();
                break;
            }
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
          isLive: true,
          url: url
        }, {
          enableStashBuffer: false,
          liveBufferLatencyChaser: true
        });
        this.mpegtsPlayer.attachMediaElement(this.video);
        this.mpegtsPlayer.load();
        this.mpegtsPlayer.play().catch(err => console.log('MPEG-TS autoplay blocked:', err));

        this.mpegtsPlayer.on(mpegts.Events.ERROR, (type, detail, info) => {
          console.error('MPEG-TS player error:', type, detail, info);
          this.hideSpinner();
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
        await PipPlugin.enterPiP();
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
    this.spinner.classList.remove('hidden');
  }

  hideSpinner() {
    this.spinner.classList.add('hidden');
  }
}
export default VideoPlayer;
