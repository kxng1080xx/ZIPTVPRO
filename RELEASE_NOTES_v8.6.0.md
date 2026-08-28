# ZIPTV Pro v8.6.0 Release Notes

## 🌟 What's New in v8.6.0

### Anime4K Video Upscaling Engine & Preset Shaders
- **Integrated [bloc97/Anime4K](https://github.com/bloc97/Anime4K)**: Imported official GLSL shader suite into `src/shaders/anime4k/`.
- **Anime4K Real-Time Line-Art Reconstruction (`anime4k`)**:
  - Sobel edge gradient vector analysis pass to detect 2D animation and cartoon line art.
  - Refines anti-aliasing blur and thins outline compression noise without halos or ringing.
  - Paired with 9-tap Catmull-Rom bicubic upscaling and Contrast Adaptive Sharpening (CAS).
- **Multi-Mode Upscaler Selection**:
  - 🌟 **Anime4K**: Real-time line-art reconstruction & edge refinement for Anime & Cartoons.
  - ⚡ **AMD FSR / CAS**: Spatial upscaling + Contrast Adaptive Sharpening for Live TV, Movies & Sports.
  - 🔍 **Bicubic Smooth**: Pure 9-tap Catmull-Rom bicubic upscaling for noisy streams.
  - ⛔ **Off**: Native video decoding.

### Upscaler Options Modal & Player Bar Integration
- Custom **Upscaler Options Modal** accessible via Settings tile and player controls.
- Real-time **Sharpening Strength Slider** (0% to 100%).
- Quick-access **Upscaler button** (`sparkles` icon) directly in the video player control bar.

---

## 🛠️ Version & Build Information
- **App Version**: `8.6.0`
- **Synchronized Manifests**: `package.json`, `android/app/build.gradle`, `public/version.json`, `dist/version.json`.
