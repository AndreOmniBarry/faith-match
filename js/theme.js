/* ============================= CHAPTER / FINALE THEMING ============================= */
// Shifts --chapter-accent (see css/base.css, css/board.css) so different
// stages visibly look different from one another instead of every chapter
// being the same gold re-skin. Finale skins (levels 13-15) get their own,
// more saturated palette on top, so a finale reads as a genuine departure.

const CHAPTER_PALETTE = [
  '#e6b754', // gold — chapter 1, the default brand look
  '#4aa8c9', // teal
  '#e0498f', // rose
  '#9668cc', // violet
  '#3fa377', // emerald
  '#e8793f', // amber
  '#d84545', // crimson
  '#6c7ae0', // indigo
];

const FINALE_SKIN_COLORS = {
  dawn:'#f0836b', ember:'#e8793f', tempest:'#4aa8c9',
  hallowed:'#f4d78c', midnight:'#6c7ae0', harvest:'#c98b3f',
};

function applyChapterTheme(chapterNum){
  const color = CHAPTER_PALETTE[(Math.max(1,chapterNum)-1) % CHAPTER_PALETTE.length];
  document.documentElement.style.setProperty('--chapter-accent', color);
}
function applyFinaleSkin(skinId){
  const color = FINALE_SKIN_COLORS[skinId];
  if(color) document.documentElement.style.setProperty('--chapter-accent', color);
}
function resetTheme(){
  document.documentElement.style.setProperty('--chapter-accent', CHAPTER_PALETTE[0]);
}

export { applyChapterTheme, applyFinaleSkin, resetTheme };
