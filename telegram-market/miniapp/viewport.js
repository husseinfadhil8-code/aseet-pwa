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
 safeCall('ready'); safeCall('expand');
 // Do not request Telegram-only capabilities for an ordinary browser visitor.
 if (tg?.initData && ['ios', 'android'].includes(tg.platform)) {
  if (supports('7.7')) safeCall('disableVerticalSwipes');
  if (supports('8.0')) safeCall('requestFullscreen');
 }
 for (const event of ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged', 'fullscreenFailed', 'viewportChanged']) safeCall('onEvent', event, sync);
 sync();
}
