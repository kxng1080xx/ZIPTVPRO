import type { PluginListenerHandle } from '@capacitor/core';

/**
 * iOS MobileVLCKit player. Mirrors the Android `NativeVideo` plugin so the app's
 * existing src/components/native-player.js bridge works unchanged. The app
 * registers this by name (`registerPlugin('NativeVideo')`) rather than importing
 * this package, so these types are documentation of the native contract.
 *
 * Events: 'ready' | 'state' | 'vout' | 'timeupdate' | 'buffering' | 'ended' | 'error'
 */
export interface NativeVideoPlugin {
  load(options: { url: string; isLive?: boolean; startAt?: number; title?: string; rect?: unknown }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { position: number }): Promise<void>;          // fractional 0..1
  setVolume(options: { volume: number }): Promise<void>;        // 0..1
  setRect(options: { x: number; y: number; w: number; h: number }): Promise<void>; // device px
  stop(): Promise<void>;
  getAudioTracks(): Promise<{ tracks: Array<{ id: number; name: string }> }>;
  keepAwake(): Promise<void>;
  allowSleep(): Promise<void>;
  isTv(): Promise<{ tv: boolean }>;
  addListener(eventName: string, listener: (data: unknown) => void): Promise<PluginListenerHandle>;
}
