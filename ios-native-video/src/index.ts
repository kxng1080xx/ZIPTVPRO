import { registerPlugin } from '@capacitor/core';

import type { NativeVideoPlugin } from './definitions';

const NativeVideo = registerPlugin<NativeVideoPlugin>('NativeVideo');

export * from './definitions';
export { NativeVideo };
