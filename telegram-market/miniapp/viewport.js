// Telegram owns fullscreen and system gestures. Unsupported clients keep normal scrolling.
export function setupViewport(tg, root = document.documentElement) {
 const safeCall = (method, ...args) => { try { tg?.[method]?.(...args); } catch {} };
 const supports = version => { try { return tg?.isVersionAtLeast?.(version) === true; } catch { return false; } };
 const sync = () => {
  for (const [prefix, value] of [['safe', tg?.safeAreaInset], ['content', tg?.contentSafeAreaInset]]) {
   for (const edge of ['top', 'right', 'bottom', 'left']) {
    const n = Number(value?.[edge]);
    root.style.setProperty(`--tg-${prefix}-${edge}`, `${Number.isFinite(n) && n >= 0 ? Math.min(n, 500) : 0}px`);
   }
  }
  root.dataset.fullscreen = tg?.isFullscreen === true ? 'true' : 'false';
 };
 for (const event of ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged', 'fullscreenFailed', 'viewportChanged']) safeCall('onEvent', event, sync);
 safeCall('ready');
 if (tg?.isFullscreen !== true) safeCall('expand');
 // Do not request Telegram-only capabilities for an ordinary browser visitor.
 if (tg?.initData && ['ios', 'android'].includes(tg.platform)) {
  if (supports('7.7')) safeCall('disableVerticalSwipes');
  if (supports('8.0') && tg.isFullscreen !== true) safeCall('requestFullscreen');
 }
 sync();
}

// Telegram, not web content, chooses native close/menu geometry and contrast.
export function syncChrome(tg, root = document.documentElement) {
 const dark = tg?.colorScheme === 'dark';
 if (tg?.colorScheme === 'dark' || tg?.colorScheme === 'light') root.dataset.theme = tg.colorScheme;
 const surface = dark ? '#192823' : '#ffffff';
 const background = dark ? '#101b18' : '#f5f6f8';
 const supports = version => { try { return tg?.isVersionAtLeast?.(version) === true; } catch { return false; } };
 // Old clients accept only Telegram's theme keywords for the header.
 try { tg?.setHeaderColor?.(supports('6.9') ? surface : 'bg_color'); } catch {}
 try { tg?.setBackgroundColor?.(background); } catch {}
 if (supports('7.10')) { try { tg?.setBottomBarColor?.(surface); } catch {} }
}
