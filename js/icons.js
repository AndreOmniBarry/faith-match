/* ============================= TILE ICONS ============================= */
// Hand-authored inline SVG glyphs, one per symbol — shape-coded, not just
// color-coded, so tiles stay tellable-apart at a glance for colorblind
// players too. Rendered as flat cream silhouettes so they read clean
// against any tile-color gradient.
// viewBox is always 0 0 24 24.

const PATHS = {
  cross: '<path d="M10 1h4v7h7v4h-7v11h-4V12H3V8h7V1z"/>',
  dove: `
    <ellipse cx="13" cy="13" rx="7.5" ry="4.2" transform="rotate(-16 13 13)"/>
    <circle cx="5.6" cy="8.6" r="2.3"/>
    <path d="M3.6 7.8L1 6.6l2.4 3z"/>
    <path d="M13 9.6c2.8-2.8 6.6-2.8 8.6-.8-2.6 0-4.4 1-5.2 2.6 1.8 0 3.6.9 4.6 2.6-2.8 0-5.6-1-7.4-2.8z"/>
  `,
  heart: '<path d="M12 21S3.9 15.6 3.9 9.9C3.9 6.9 6 5 8.5 5c1.8 0 3.1 1 3.5 2.4C12.4 6 13.7 5 15.5 5 18 5 20.1 6.9 20.1 9.9 20.1 15.6 12 21 12 21z"/>',
  star: '<path d="M12 1.5l3 6.9 7.4.7-5.6 5 1.7 7.4L12 17.6l-6.5 3.9 1.7-7.4-5.6-5 7.4-.7L12 1.5z"/>',
  crown: '<path d="M2.5 8l4.5 4 5-8 5 8 4.5-4-2 11h-15l-2-11z"/><rect x="4" y="19.5" width="16" height="2.5" rx="0.6"/>',
  hands: '<path d="M12 2.2c-3.8 3.2-4.6 7.4-4.6 10.8 0 4.2 2 7.4 4.6 8.8 2.6-1.4 4.6-4.6 4.6-8.8 0-3.4-.8-7.6-4.6-10.8z"/><rect x="11.4" y="3.5" width="1.2" height="17" opacity="0.55"/>',
  flame: '<path d="M12 1.8c2.3 4.4-2.6 5.7-2.6 9.6a2.6 2.6 0 005.2 0c0-1.8-.9-2.7-.9-2.7s2.9.9 2.9 5A5.6 5.6 0 0111 19a5.6 5.6 0 01-4.6-6c0-5.3 4.1-6.2 4.1-6.2s-1-2.7 1.5-5z"/>',
  anchor: `
    <circle cx="12" cy="4.6" r="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <rect x="11.1" y="6.6" width="1.8" height="14" />
    <rect x="7" y="9.6" width="10" height="1.8" />
    <path d="M4 13.5c0 4.4 3.3 7.6 7 8.3v-2.6c-2.4-.7-4.4-2.7-4.4-5.7z"/>
    <path d="M20 13.5c0 4.4-3.3 7.6-7 8.3v-2.6c2.4-.7 4.4-2.7 4.4-5.7z"/>
  `,
};

const ORDER = ['cross','dove','heart','star','crown','hands','flame','anchor'];

function iconMarkup(typeIndex){
  const key = ORDER[typeIndex] || 'star';
  return PATHS[key] || PATHS.star;
}

function iconSVG(typeIndex){
  return `<svg class="tile-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${iconMarkup(typeIndex)}</svg>`;
}

export { iconSVG, ORDER };
