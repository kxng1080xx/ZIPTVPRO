'use strict';
// Prebuilt CJS stub — see dist/esm/index.js. The app registers `NativeVideo` by
// name; this exists only to make the package a valid Capacitor plugin for
// `cap sync ios` (which adds the MobileVLCKit-backed ZiptvNativeVideo pod).
Object.defineProperty(exports, '__esModule', { value: true });
const core = require('@capacitor/core');
const NativeVideo = core.registerPlugin('NativeVideo');
exports.NativeVideo = NativeVideo;
