// Keep the static folio independent of Three and renderer initialization (§15).
// v1.8.0: the page layer's styles ship with this small entry chunk, so the title is styled at
// first paint rather than after the engine script has downloaded.
import './director/story.css';

const query = new URLSearchParams(location.search);
const diagnostic = ['capture', 'probe', 'calibrate'].some(key => query.has(key))
  || ['ramp', 'inkrt'].includes(query.get('scene') ?? '');

// v1.8.0: a swipe while the poster is still up gets an answer — the page scrolls (index.html
// carries the scroll length) and a quiet note says the manuscript is on its way. Story takes
// the note over on its first frame.
if (!diagnostic) {
  const wait = document.getElementById('story-wait');
  const onEarlyScroll = (): void => {
    if (!wait || wait.dataset.owned) { removeEventListener('scroll', onEarlyScroll); return; }
    if (scrollY < 40) return;
    const text = wait.querySelector('span:last-child');
    if (text) text.textContent = 'The manuscript is arriving';
    wait.classList.remove('is-off');
    wait.removeAttribute('aria-hidden');
    wait.style.transition = 'opacity .35s ease-out';
    wait.style.opacity = '1';
    removeEventListener('scroll', onEarlyScroll);
  };
  addEventListener('scroll', onEarlyScroll, { passive: true });
}
try {
  if (query.has('fallback') && !diagnostic) {
    const { showFallback } = await import('./fallback');
    showFallback();
  } else {
    await import('./main');
  }
} catch (error) {
  console.error('Manuscript startup failed', error);
  if (diagnostic) {
    window.__captureError = String(error);
    const status = document.getElementById('cap');
    if (status) status.textContent = `Capture failed: ${String(error)}`;
  } else {
    const { showFallback } = await import('./fallback');
    showFallback();
  }
}
export {};
