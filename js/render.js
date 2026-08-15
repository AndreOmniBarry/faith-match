/* ============================= TILE RENDERING ============================= */
// Owns the DOM side of the board: creating/updating tile elements, keeping
// them positioned via CSS transform, and the small landing/swap motion that
// gives matches weight. Knows nothing about match rules — engine.js drives it.

import { SYMBOLS } from './content.js';

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
  return `<div class="tile-inner" style="--tile-color:${SYMBOLS[tile.type].color}"><span class="tile-emoji">${SYMBOLS[tile.type].emoji}</span></div>${badgeFor(tile)}${veilBadge(tile)}`;
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
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const tile = tilesById.get(grid[r][c]);
      const el = createTileEl(tile, onPointerDown);
      tile.el = el;
      setTileTransform(el, r, c);
      el.style.opacity = '0';
      el.style.transition = 'none';
      boardEl.appendChild(el);
    }
  }
  requestAnimationFrame(()=>{
    let i=0;
    for(let r=0;r<rows;r++){
      for(let c=0;c<cols;c++){
        const tile = tilesById.get(grid[r][c]);
        const el = tile.el;
        setTimeout(()=>{
          el.style.transition = 'opacity .3s ease, transform .28s cubic-bezier(.34,1.15,.64,1)';
          el.style.opacity = '1';
        }, i*6);
        i++;
      }
    }
  });
}

function removeTileEl(tile){
  if(tile.el && tile.el.parentNode) tile.el.parentNode.removeChild(tile.el);
}

export {
  setBoardEl, getBoardEl, measureTileSize, getTileSize, cellCenter, setTileTransform,
  createTileEl, refreshTileVisual, renderFullBoard, removeTileEl,
  playLandAnimation, playSwapStretch,
};
