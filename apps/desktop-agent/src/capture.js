export const MAX_WIDTH = 1920;

/** Scales a size down (never up) to fit within maxWidth, keeping the aspect ratio. */
export function fitWithin(width, height, maxWidth = MAX_WIDTH) {
  if (width <= maxWidth) return { width: Math.round(width), height: Math.round(height) };
  return { width: maxWidth, height: Math.round((height * maxWidth) / width) };
}

/**
 * Screen capture with Electron's desktopCapturer (which uses the OS capture APIs and their
 * permission prompts). ACTIVE_SCREEN captures only the display under the pointer; ALL_SCREENS
 * returns one image per display. Blur is applied on the device, before anything is stored or
 * uploaded, by downscaling heavily and scaling back up.
 */
export function createCapturer({ desktopCapturer, screen, jpegQuality = 70 }) {
  return {
    async capture({ mode = 'ACTIVE_SCREEN', blur = false } = {}) {
      const displays = mode === 'ALL_SCREENS' ? screen.getAllDisplays() : [screen.getDisplayNearestPoint(screen.getCursorScreenPoint())];
      const largest = displays.reduce(
        (acc, d) => {
          const px = fitWithin(d.size.width * d.scaleFactor, d.size.height * d.scaleFactor);
          return { width: Math.max(acc.width, px.width), height: Math.max(acc.height, px.height) };
        },
        { width: 1, height: 1 },
      );
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: largest, fetchWindowIcons: false });
      const images = [];
      for (const display of displays) {
        const source = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : null);
        if (!source || source.thumbnail.isEmpty()) throw new Error('The screen could not be captured (is screen-recording permission granted?)');
        let image = source.thumbnail;
        const size = image.getSize();
        if (blur) {
          const small = image.resize({ width: Math.max(16, Math.round(size.width / 24)), quality: 'good' });
          image = small.resize({ width: size.width, height: size.height, quality: 'good' });
        }
        images.push({ bytes: image.toJPEG(jpegQuality), width: size.width, height: size.height, mimeType: 'image/jpeg' });
      }
      return images;
    },
  };
}
