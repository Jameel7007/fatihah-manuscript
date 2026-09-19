import { assetUrl } from './core/url';
import './fallback.css';

const labels = ['Rolled parchment', 'Unrolling', 'Ink being written', 'Presenting the page',
  'Gilded relief', 'Risen text', 'Facing the viewer'];

export function showFallback(): void {
  if (document.getElementById('folio')) return;
  document.body.classList.add('fallback');
  const section = document.createElement('section');
  section.id = 'folio';
  section.setAttribute('aria-label', 'Al-Fātiḥah — seven manuscript plates');
  const intro = document.createElement('p');
  intro.textContent = 'The animated renderer is unavailable. Explore the manuscript in seven still plates.';
  const track = document.createElement('div');
  track.className = 'folio-track';
  track.tabIndex = 0;
  // a focusable generic <div> may not carry aria-label (ARIA 1.2 prohibits it on generics —
  // axe 4.10 'aria-prohibited-attr'); a named region is the honest role for the plate strip
  track.setAttribute('role', 'region');
  track.setAttribute('aria-label', 'Manuscript plates. Swipe or use the arrow keys.');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const previous = document.createElement('button');
  previous.textContent = 'Previous plate';
  const next = document.createElement('button');
  next.textContent = 'Next plate';
  let current = 0;
  const update = () => {
    current = Math.max(0, Math.min(6, Math.round(track.scrollLeft / Math.max(1, track.clientWidth))));
    status.textContent = `Plate ${current + 1} of 7 — ${labels[current]}`;
    previous.disabled = current === 0;
    next.disabled = current === 6;
  };
  const go = (index: number) => {
    track.scrollTo({ left: Math.max(0, Math.min(6, index)) * track.clientWidth, behavior: 'instant' });
    update();
  };
  labels.forEach((label, index) => {
    const figure = document.createElement('figure');
    const img = document.createElement('img');
    img.alt = `Al-Fātiḥah manuscript: ${label.toLowerCase()}`;
    img.decoding = 'async';
    img.src = assetUrl(`fallback/plate-${index + 1}.jpg`);
    const caption = document.createElement('figcaption');
    caption.textContent = `${index + 1} / 7 — ${label}`;
    img.addEventListener('load', () => figure.classList.add('loaded'));
    img.addEventListener('error', () => {
      caption.textContent = `${index + 1} / 7 — ${label}. Image unavailable; the opening poster is shown.`;
      img.hidden = true;
    });
    figure.append(img, caption);
    track.append(figure);
  });
  previous.addEventListener('click', () => go(current - 1));
  next.addEventListener('click', () => go(current + 1));
  track.addEventListener('scroll', update, { passive: true });
  track.addEventListener('keydown', event => {
    const destination = event.key === 'ArrowRight' ? current + 1 : event.key === 'ArrowLeft' ? current - 1
      : event.key === 'Home' ? 0 : event.key === 'End' ? 6 : null;
    if (destination !== null) { event.preventDefault(); go(destination); }
  });
  new ResizeObserver(() => go(current)).observe(track);
  const controls = document.createElement('nav');
  controls.setAttribute('aria-label', 'Plate navigation');
  controls.append(previous, status, next);
  section.append(intro, track, controls);
  document.querySelector('main')!.append(section);
  update();
}
