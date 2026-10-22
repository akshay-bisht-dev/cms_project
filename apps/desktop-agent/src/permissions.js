// The agent relies on the operating system's own consent for screen capture and never tries
// to work around it.

const MAC_SCREEN_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export function createPermissions({ platform, systemPreferences, shell, desktopCapturer }) {
  return {
    /** 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' */
    async status() {
      if (platform === 'darwin') return systemPreferences.getMediaAccessStatus('screen');
      // Windows has no per-app screen-capture permission; on Linux, Wayland asks via its portal per capture.
      return 'granted';
    },

    /**
     * Asks the OS for permission, only ever from an explicit click in the status window. On
     * macOS the first capture attempt shows the system prompt; after a denial only System
     * Settings can change it, so we open that page.
     */
    async request() {
      if (platform !== 'darwin') return 'granted';
      const current = systemPreferences.getMediaAccessStatus('screen');
      if (current === 'not-determined') {
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
      } else if (current !== 'granted') {
        await shell.openExternal(MAC_SCREEN_SETTINGS);
      }
      return systemPreferences.getMediaAccessStatus('screen');
    },

    async openSettings() {
      if (platform === 'darwin') await shell.openExternal(MAC_SCREEN_SETTINGS);
    },
  };
}
