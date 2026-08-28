// Prebuilt stub — the ZIPTV app registers `NativeVideo` by name directly
// (src/components/native-player.js), so this package's JS is never imported at
// runtime. It exists only so `cap sync ios` treats this as a valid plugin and
// adds the ZiptvNativeVideo pod (MobileVLCKit) to the iOS project.
import { registerPlugin } from '@capacitor/core';
const NativeVideo = registerPlugin('NativeVideo');
export { NativeVideo };
