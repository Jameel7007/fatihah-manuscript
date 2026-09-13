// Keep the static folio independent of Three and renderer initialization (§15).
const query = new URLSearchParams(location.search);
const diagnostic = ['capture', 'probe', 'calibrate'].some(key => query.has(key))
  || ['ramp', 'inkrt'].includes(query.get('scene') ?? '');
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
