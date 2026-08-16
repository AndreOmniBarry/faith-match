/* ============================= TILE RENDERING ============================= */
// Owns the DOM side of the board: creating/updating tile elements, keeping
// them positioned via CSS transform, and the small landing/swap motion that
// gives matches weight. Knows nothing about match rules — engine.js drives it.

import { SYMBOLS } from './content.js';
import { iconSVG } from './icons.js';

let boardEl = null;
let tileSize = 40;

function setBoardEl(el){ boardEl = el; }
function getBoardEl(){ return boardEl; }

function measureTileSize(cols){
  const rect = boardEl.getBoundingClientRect();
  tileSize = rect.width / cols;
  return tileSize;
}
function getTileSize(){ return tileSize; }
function cellCenter(r,c){ return { x:(c+0.5)*tileSize, y:(r+0.5)*tileSize }; }

function setTileTransform(el,r,c){
  el.style.transform = `translate(${c*tileSize}px, ${r*tileSize}px)`;
}

function badgeFor(tile){
  if(!tile.special) return '';
  if(tile.special.kind==='wrapped') return '<span class="tile-badge">💫</span>';
  if(tile.special.kind==='colorbomb') return '<span class="tile-badge">🌈</span>';
  return '<span class="tile-badge">✨</span>'; // striped
}
function veilBadge(tile){
  if(!tile.veil) return '';
  return `<div class="veil-layer">${'🔒'.repeat(1)}<span style="margin-left:2px">${tile.veil}</span></div>`;
}
function classFor(tile){
  let cls = 'tile';
  if(tile.special){
    cls += tile.special.kind==='striped' ? ' special-striped'
         : tile.special.kind==='wrapped' ? ' special-wrapped'
         : ' special-colorbomb';
  }
  if(tile.veil) cls += ' veil-locked';
  return cls;
}
function innerHTMLFor(tile){
  return `<div class="tile-inner" style="--tile-color:${SYMBOLS[tile.type].color}">${iconSVG(tile.type)}</div>${badgeFor(tile)}${veilBadge(tile)}`;
}

function createTileEl(tile, onPointerDown){
  const el = document.createElement('div');
  el.className = classFor(tile);
  el.dataset.id = tile.id;
  el.style.width = tileSize+'px';
  el.style.height = tileSize+'px';
  el.innerHTML = innerHTMLFor(tile);
  if(onPointerDown) el.addEventListener('pointerdown', onPointerDown);
  return el;
}
function refreshTileVisual(tile){
  tile.el.className = classFor(tile);
  tile.el.innerHTML = innerHTMLFor(tile);
}

function playLandAnimation(tile){
  if(!tile.el) return;
  tile.el.classList.remove('land');
  void tile.el.offsetWidth;
  tile.el.classList.add('land');
  setTimeout(()=>{ if(tile.el) tile.el.classList.remove('land'); }, 260);
}
function playSwapStretch(tile){
  if(!tile.el) return;
  tile.el.classList.remove('swap-stretch');
  void tile.el.offsetWidth;
  tile.el.classList.add('swap-stretch');
  setTimeout(()=>{ if(tile.el) tile.el.classList.remove('swap-stretch'); }, 220);
}

function renderFullBoard(rows, cols, grid, tilesById, onPointerDown){
  boardEl.innerHTML = '';
  measureTileSize(cols);
  // Deal-in: a staggered 3D flip per tile (see css/board.css .deal-in),
  // instead of a flat opacity tween — a bit of flourish on the one moment
  // (board load) that can afford it without adding motion to every cascade.
  let i = 0;
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const tile = tilesById.get(grid[r][c]);
      const el = createTileEl(tile, onPointerDown);
      tile.el = el;
      setTileTransform(el, r, c);
      el.classList.add('deal-in');
      el.style.setProperty('--deal-delay', (i*14)+'ms');
      boardEl.appendChild(el);
      i++;
    }
  }
  const totalDealMs = i*14 + 500;
  setTimeout(()=>{
    boardEl.querySelectorAll('.tile.deal-in').forEach(el=>el.classList.remove('deal-in'));
  }, totalDealMs);
}

function removeTileEl(tile){
  if(tile.el && tile.el.parentNode) tile.el.parentNode.removeChild(tile.el);
}

export {
  setBoardEl, getBoardEl, measureTileSize, getTileSize, cellCenter, setTileTransform,
  createTileEl, refreshTileVisual, renderFullBoard, removeTileEl,
  playLandAnimation, playSwapStretch,
};
