/**
 * WebGL video upscaler — FSR-1-style spatial upscaling for the Chromium
 * <video> path (Electron desktop, web, and the Android <video> fallback).
 *
 * Pipeline (two GPU passes, runs once per decoded frame):
 *   1. Catmull-Rom bicubic upscale  — source resolution -> display resolution.
 *      Sharper and cleaner than the browser's default bilinear stretch. This is
 *      the practical stand-in for FSR's EASU pass: on already-compressed video
 *      (no clean edges or subpixel data like a game frame has) edge-adaptive
 *      upscaling buys little over a good bicubic, and this is rock-solid.
 *   2. CAS (Contrast Adaptive Sharpening) — AMD's kernel, the basis of FSR's
 *      RCAS pass. Adds local sharpness where the image is soft while limiting
 *      itself in already-high-contrast areas so it doesn't ring or amplify
 *      block noise. Strength is adjustable.
 *
 * Why not "real" FSR 2/3 or DLSS: those are temporal and need per-frame motion
 * vectors from a 3D engine, which video streams don't have. FSR 1 (spatial) is
 * the only member of either family that applies to arbitrary video.
 *
 * Engine-agnostic: it reads pixels straight off the <video> element, so it works
 * the same whether hls.js, mpegts.js, or direct playback is driving it. It does
 * NOT affect the Android libVLC surface (that renders behind the WebView).
 *
 * Usage:
 *   const up = new Upscaler(videoEl, containerEl);
 *   up.enable();            // start processing
 *   up.setSharpness(0.5);   // 0..1
 *   up.disable();           // show the raw <video> again
 *   up.destroy();
 */

const VERT = `#version 300 es
out vec2 vUV;
void main() {
  // Fullscreen triangle; no vertex buffer needed.
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Pass 1 — 9-tap Catmull-Rom bicubic upscale.
const FRAG_UPSCALE = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uSrcSize;   // source video resolution in pixels

vec4 catmullRom(vec2 uv, vec2 texSize) {
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / w12;
  vec2 texPos0  = (texPos1 - 1.0) / texSize;
  vec2 texPos3  = (texPos1 + 2.0) / texSize;
  vec2 texPos12 = (texPos1 + offset12) / texSize;
  vec4 r = vec4(0.0);
  r += texture(uTex, vec2(texPos0.x,  texPos0.y )) * w0.x  * w0.y;
  r += texture(uTex, vec2(texPos12.x, texPos0.y )) * w12.x * w0.y;
  r += texture(uTex, vec2(texPos3.x,  texPos0.y )) * w3.x  * w0.y;
  r += texture(uTex, vec2(texPos0.x,  texPos12.y)) * w0.x  * w12.y;
  r += texture(uTex, vec2(texPos12.x, texPos12.y)) * w12.x * w12.y;
  r += texture(uTex, vec2(texPos3.x,  texPos12.y)) * w3.x  * w12.y;
  r += texture(uTex, vec2(texPos0.x,  texPos3.y )) * w0.x  * w3.y;
  r += texture(uTex, vec2(texPos12.x, texPos3.y )) * w12.x * w3.y;
  r += texture(uTex, vec2(texPos3.x,  texPos3.y )) * w3.x  * w3.y;
  return r;
}

void main() { o = catmullRom(vUV, uSrcSize); }`;

// Pass 2 — CAS (Contrast Adaptive Sharpening), AMD's kernel.
const FRAG_SHARPEN = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;     // 1.0 / outputSize
uniform float uSharp;    // 0 (gentle) .. 1 (strong)

void main() {
  vec3 e = texture(uTex, vUV).rgb;                                  // center
  vec3 b = texture(uTex, vUV + vec2(0.0, -uTexel.y)).rgb;           // up
  vec3 d = texture(uTex, vUV + vec2(-uTexel.x, 0.0)).rgb;           // left
  vec3 f = texture(uTex, vUV + vec2(uTexel.x, 0.0)).rgb;            // right
  vec3 h = texture(uTex, vUV + vec2(0.0, uTexel.y)).rgb;            // down

  vec3 mn = min(min(min(b, d), min(f, h)), e);
  vec3 mx = max(max(max(b, d), max(f, h)), e);

  vec3 rcpM = 1.0 / max(mx, vec3(1e-4));
  vec3 amp = clamp(min(mn, 1.0 - mx) * rcpM, 0.0, 1.0);
  amp = sqrt(amp);

  // Sharpening weight: peak strength scales from -1/8 (soft) to -1/5 (strong).
  float peak = -1.0 / mix(8.0, 5.0, clamp(uSharp, 0.0, 1.0));
  vec3 w = amp * peak;
  vec3 rcpW = 1.0 / (1.0 + 4.0 * w);
  vec3 col = ((b + d + f + h) * w + e) * rcpW;

  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export class Upscaler {
  constructor(video, container) {
    this.video = video;
    this.container = container;
    this.sharpness = 0.4;
    this.enabled = false;
    this._raf = null;
    this._rvfc = null;

    const canvas = document.createElement('canvas');
    canvas.className = 'upscaler-canvas';
    Object.assign(canvas.style, {
      position: 'absolute', pointerEvents: 'none', display: 'none',
      // sit directly over the video; rect is synced in _resize()
      left: '0', top: '0',
    });
    this.canvas = canvas;

    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, premultipliedAlpha: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    this.gl = gl;
    this.supported = !!gl;
    if (!gl) return; // caller checks .supported; falls back to raw <video>

    container.appendChild(canvas);

    this.progUp = this._program(VERT, FRAG_UPSCALE);
    this.progSharp = this._program(VERT, FRAG_SHARPEN);

    // Source texture (video frames) — LINEAR so the bicubic taps are clean.
    this.srcTex = this._texture(gl.LINEAR);
    // Intermediate texture (upscaled result) + its framebuffer.
    this.midTex = this._texture(gl.LINEAR);
    this.fbo = gl.createFramebuffer();

    this.vao = gl.createVertexArray(); // empty VAO for the fullscreen triangle

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this.video.addEventListener('loadedmetadata', this._onResize);
    document.addEventListener('fullscreenchange', this._onResize);
  }

  _program(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error('Upscaler shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('Upscaler link: ' + gl.getProgramInfoLog(p));
    return {
      p,
      u: {
        tex: gl.getUniformLocation(p, 'uTex'),
        srcSize: gl.getUniformLocation(p, 'uSrcSize'),
        texel: gl.getUniformLocation(p, 'uTexel'),
        sharp: gl.getUniformLocation(p, 'uSharp'),
      },
    };
  }

  _texture(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    return t;
  }

  // Match the canvas to the video's on-screen content box (object-fit: contain),
  // so aspect ratio is preserved and letterboxing lines up with the raw video.
  _resize() {
    if (!this.supported) return;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    if (!vw || !vh || !cw || !ch) return;

    const scale = Math.min(cw / vw, ch / vh);
    const dispW = Math.round(vw * scale), dispH = Math.round(vh * scale);
    const left = Math.round((cw - dispW) / 2), top = Math.round((ch - dispH) / 2);

    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap for perf
    this.canvas.style.left = left + 'px';
    this.canvas.style.top = top + 'px';
    this.canvas.style.width = dispW + 'px';
    this.canvas.style.height = dispH + 'px';
    this.canvas.width = Math.max(1, Math.round(dispW * dpr));
    this.canvas.height = Math.max(1, Math.round(dispH * dpr));

    // (Re)allocate the intermediate texture at output resolution.
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.midTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.canvas.width, this.canvas.height,
      0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  setSharpness(v) { this.sharpness = Math.max(0, Math.min(1, v)); }

  enable() {
    if (!this.supported || this.enabled) return;
    this.enabled = true;
    this._resize();
    this.canvas.style.display = 'block';
    this.video.style.visibility = 'hidden'; // keep decoding + audio, hide pixels
    this._loop();
  }

  disable() {
    this.enabled = false;
    if (this._rvfc && this.video.cancelVideoFrameCallback)
      this.video.cancelVideoFrameCallback(this._rvfc);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._rvfc = this._raf = null;
    if (this.canvas) this.canvas.style.display = 'none';
    this.video.style.visibility = '';
  }

  toggle() { this.enabled ? this.disable() : this.enable(); return this.enabled; }

  // Render on every decoded frame when the browser supports it (perfectly synced,
  // no wasted work on paused/static video); fall back to rAF otherwise.
  _loop() {
    const draw = () => {
      if (!this.enabled) return;
      this._render();
      if (this.video.requestVideoFrameCallback)
        this._rvfc = this.video.requestVideoFrameCallback(draw);
      else
        this._raf = requestAnimationFrame(draw);
    };
    draw();
  }

  _render() {
    const gl = this.gl;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh || this.video.readyState < 2) return;
    if (this.canvas.width < 1) this._resize();

    // Upload the current video frame.
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    } catch (e) { return; } // frame not ready / cross-origin taint
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    gl.bindVertexArray(this.vao);

    // Pass 1: bicubic upscale -> intermediate texture (output resolution).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.midTex, 0);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.progUp.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(this.progUp.u.tex, 0);
    gl.uniform2f(this.progUp.u.srcSize, vw, vh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 2: CAS sharpen -> screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.progSharp.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.midTex);
    gl.uniform1i(this.progSharp.u.tex, 0);
    gl.uniform2f(this.progSharp.u.texel, 1 / this.canvas.width, 1 / this.canvas.height);
    gl.uniform1f(this.progSharp.u.sharp, this.sharpness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy() {
    this.disable();
    window.removeEventListener('resize', this._onResize);
    this.video.removeEventListener('loadedmetadata', this._onResize);
    document.removeEventListener('fullscreenchange', this._onResize);
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }
}
