// Safari toolbars and the on-screen keyboard can cover part of the layout
// viewport. Keep end-of-page controls scrollable above that covered area.
let pending = false;
function updateViewport() {
  pending = false;
  const viewport = window.visualViewport;
  const covered = viewport
    ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
    : 0;
  document.documentElement.style.setProperty('--covered-bottom', `${Math.ceil(covered)}px`);
}
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(updateViewport);
}
window.addEventListener('resize', schedule, {passive:true});
window.addEventListener('orientationchange', schedule, {passive:true});
window.visualViewport?.addEventListener('resize', schedule, {passive:true});
window.visualViewport?.addEventListener('scroll', schedule, {passive:true});
updateViewport();
