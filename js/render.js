/* ============================= TILE RENDERING (WebGL / PixiJS) ============================= */
// Owns the board's actual pixels: a PIXI.Application mounted into the
// existing #fx-canvas element (reusing its CSS positioning — no DOM/layout
// changes needed), tile textures generated procedurally at runtime from
// js/icons.js's path data (rasterized once via the browser's native SVG
// support, then GPU-cached), and tween-driven motion instead of CSS
// transitions. engine.js still treats what this returns as an opaque `el`
// handle with a `.classList.add/remove(name)` surface, matching the old
// DOM-based module's contract, so the match-rules code barely changed.

import { SYMBOLS } from './content.js';
import { iconSVG } from './icons.js';

let app = null;
let boardEl = null;
let canvasEl = null;
let boardLayer = null;
let tileSize = 40;
let cols = 8, rows = 8;
const baseTextures = new Map(); // type index -> PIXI.Texture (shared, reused per tile)
let readyPromise = null;

/* ============================= INIT ============================= */

function ensureApp(){
  if(app) return app;
  canvasEl = document.getElementById('fx-canvas');
  app = new PIXI.Application();
  boardLayer = new PIXI.Container();
  readyPromise = app.init({
    canvas: canvasEl,
    width: 400, height: 400,
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(2, window.devicePixelRatio||1),
    autoDensity: true,
  }).then(()=>{
    app.stage.addChild(boardLayer);
    return buildAllTextures();
  }).catch(e=>{ /* WebGL unavailable — tiles simply won't render; nothing else in the app depends on this promise settling */ });
  return app;
}

function hexOf(cssColorVar){
  // Resolve a `var(--c-xxx)` (or plain color) CSS string to a 0xRRGGBB int.
  let c = cssColorVar;
  if(typeof c==='string' && c.startsWith('var(')){
    const name = c.slice(4, c.endsWith(')') ? -1 : undefined).split(',')[0].trim();
    c = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#f4d78c';
  }
  if(c[0]==='#') c = c.slice(1);
  if(c.length===3) c = c.split('').map(ch=>ch+ch).join('');
  return parseInt(c,16) || 0xf4d78c;
}
function mixHex(a,b,pct){ // pct = weight of `a`, 0..1
  const ar=(a>>16)&255, ag=(a>>8)&255, ab=a&255;
  const br=(b>>16)&255, bg=(b>>8)&255, bb=b&255;
  const r=Math.round(ar*pct+br*(1-pct)), g=Math.round(ag*pct+bg*(1-pct)), bl=Math.round(ab*pct+bb*(1-pct));
  return (r<<16)|(g<<8)|bl;
}

function loadIconTexture(typeIndex){
  return new Promise((resolve)=>{
    try{
      // xmlns is required here even though it's optional when the same
      // markup is injected via innerHTML — this SVG is loaded as a
      // standalone document (data URI -> <img>), which needs real XML.
      const svg = iconSVG(typeIndex)
        .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" ')
        .replace(/currentColor/g, '#f8f0df');
      const img = new Image();
      img.onload = ()=>{ try{ resolve(PIXI.Texture.from(img)); }catch(e){ resolve(null); } };
      img.onerror = ()=> resolve(null);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }catch(e){ resolve(null); }
  });
}

// Builds one shared "gem" texture per symbol type: base color fill, a
// layered highlight/facet (alpha-blended shapes — avoids relying on a
// gradient-fill API surface I haven't independently verified in this exact
// build), and the rasterized icon glyph on top. Rendered once per type,
// reused by every tile instance of that type for the rest of the session.
async function buildAllTextures(){
  const size = 128;
  for(let t=0;t<SYMBOLS.length;t++){
    const base = hexOf(SYMBOLS[t].color);
    const light = mixHex(0xffffff, base, 0.22);
    const dark = mixHex(0x000000, base, 0.20);

    const c = new PIXI.Container();
    const g = new PIXI.Graphics();
    g.roundRect(0,0,size,size,size*0.3).fill({ color: base });
    // faux-gradient: a lighter wash top-left, a darker wash bottom-right
    g.roundRect(0,0,size,size*0.55,size*0.3).fill({ color: light, alpha:0.35 });
    g.roundRect(0,size*0.5,size,size*0.5,size*0.3).fill({ color: dark, alpha:0.3 });
    // specular highlight
    g.circle(size*0.32, size*0.28, size*0.22).fill({ color:0xffffff, alpha:0.4 });
    // facet sliver
    g.moveTo(size*0.42,0).lineTo(size*0.58,0).lineTo(size*0.28,size).lineTo(size*0.12,size).closePath().fill({ color:0xffffff, alpha:0.16 });
    c.addChild(g);

    const iconTex = await loadIconTexture(t);
    if(iconTex){
      const spr = new PIXI.Sprite(iconTex);
      spr.anchor.set(0.5);
      spr.width = size*0.56; spr.height = size*0.56;
      spr.x = size/2; spr.y = size/2;
      c.addChild(spr);
    }

    try{
      baseTextures.set(t, app.renderer.generateTexture(c));
    }catch(e){ /* leave unset; tile creation will fall back to a plain fill */ }
    c.destroy({ children:true });
  }

  // A distinct swirled texture for Color Bomb tiles (visually replaces the
  // gem base — the original type's icon still shows on top, same as before).
  const cb = new PIXI.Container();
  const cg = new PIXI.Graphics();
  cg.circle(64,64,62).fill({ color: mixHex(0xffffff, hexOf('var(--colorbomb-glow)'), 0.15) });
  cg.circle(50,45,38).fill({ color: 0xffffff, alpha:0.4 });
  cg.circle(70,80,30).fill({ color: mixHex(0x000000, hexOf('var(--colorbomb-glow)'), 0.25), alpha:0.4 });
  cb.addChild(cg);
  try{ baseTextures.set('colorbomb', app.renderer.generateTexture(cb)); }catch(e){}
  cb.destroy({ children:true });
}

/* ============================= BOARD SIZING ============================= */

function setBoardEl(el){
  boardEl = el;
  ensureApp();
}
function getBoardEl(){ return boardEl; }
function getApp(){ ensureApp(); return app; }
function getReady(){ ensureApp(); return readyPromise; }

function measureTileSize(colsArg){
  cols = colsArg;
  const rect = boardEl.getBoundingClientRect();
  tileSize = rect.width / cols;
  if(app && rect.width>0){
    try{ app.renderer.resize(rect.width, rect.height); }catch(e){}
  }
  return tileSize;
}
function getTileSize(){ return tileSize; }
function cellCenter(r,c){ return { x:(c+0.5)*tileSize, y:(r+0.5)*tileSize }; }

/* ============================= TWEENING ============================= */
// A tiny hand-rolled tween runner driven by the Pixi ticker — no extra
// dependency for something this scoped. Each tile container can have at
// most one active positional tween and one active "effect" tween at a time.

const activeTweens = new Set();
function tween(obj, props, duration, easing, onDone){
  const start = {}; const t0 = performance.now();
  Object.keys(props).forEach(k=>start[k]=obj[k]);
  const rec = { obj, props, start, t0, duration, easing: easing||easeOutBack, onDone, done:false };
  activeTweens.add(rec);
  ensureTicker();
  return rec;
}
function cancelTweensOf(obj, keyFilter){
  activeTweens.forEach(rec=>{
    if(rec.obj===obj && (!keyFilter || Object.keys(rec.props).some(k=>keyFilter.includes(k)))) rec.done = true;
  });
}
function easeOutBack(x){ const c1=1.5, c3=c1+1; return 1+c3*Math.pow(x-1,3)+c1*Math.pow(x-1,2); }
function easeOutCubic(x){ return 1-Math.pow(1-x,3); }
let tickerAttached = false;
function ensureTicker(){
  if(tickerAttached || !app) return;
  tickerAttached = true;
  app.ticker.add(()=>{
    if(!activeTweens.size) return;
    const now = performance.now();
    activeTweens.forEach(rec=>{
      if(rec.done){ activeTweens.delete(rec); return; }
      const t = Math.min(1, (now-rec.t0)/rec.duration);
      const e = rec.easing(t);
      Object.keys(rec.props).forEach(k=>{ rec.obj[k] = rec.start[k] + (rec.props[k]-rec.start[k])*e; });
      if(t>=1){ rec.done = true; activeTweens.delete(rec); rec.onDone && rec.onDone(); }
    });
  });
}

/* ============================= TILE HANDLE ============================= */
// The object stored as `tile.el`. engine.js only ever calls
// `.classList.add/remove(name)` on it directly (for 'pop'/'spawn-special'/
// 'shake') and passes it back into this module's own functions otherwise —
// see js/engine.js's collapseAndRefill/resizeBoard for the two small spots
// that talk to a render.js tile handle a little more directly.

function specialGlowColor(kind){
  if(kind==='striped') return 0xffffff;
  if(kind==='wrapped') return hexOf('var(--wrapped-glow)');
  if(kind==='colorbomb') return hexOf('var(--colorbomb-glow)');
  return null;
}

class TileHandle{
  constructor(tile){
    this.tile = tile;
    this.container = new PIXI.Container();
    this.sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
    this.sprite.anchor.set(0.5);
    this.glow = new PIXI.Graphics();
    this.veilG = null;
    this.container.addChild(this.sprite);
    this.container.addChild(this.glow);
    this._pulseT = 0;
    this.classList = {
      add: (name)=>{
        if(name==='pop') this.playPop();
        else if(name==='spawn-special') this.playSpawnPulse();
        else if(name==='shake') this.playShake();
      },
      remove: ()=>{ /* one-shot effects clean up after themselves */ },
    };
  }
  setSize(size){
    this.sprite.width = size; this.sprite.height = size;
  }
  updateVisual(){
    const tile = this.tile;
    const tex = tile.special && tile.special.kind==='colorbomb'
      ? baseTextures.get('colorbomb')
      : baseTextures.get(tile.type);
    if(tex) this.sprite.texture = tex;
    this.setSize(tileSize*0.94);

    this.glow.clear();
    const glowColor = tile.special ? specialGlowColor(tile.special.kind) : null;
    if(glowColor!=null){
      const r = tileSize*0.5;
      this.glow.roundRect(-r,-r,r*2,r*2,r*0.55).stroke({ width:Math.max(2,tileSize*0.05), color:glowColor, alpha:0.85 });
      if(!this._pulseTicking){
        this._pulseTicking = true;
        ensureTicker();
        app.ticker.add(this._pulseFn = ()=>{
          if(!this.container.parent){ app.ticker.remove(this._pulseFn); this._pulseTicking=false; return; }
          this._pulseT += 0.06;
          this.glow.alpha = 0.6 + Math.sin(this._pulseT)*0.4;
        });
      }
    }else if(this._pulseTicking){
      app.ticker.remove(this._pulseFn); this._pulseTicking = false; this.glow.alpha = 1;
    }

    if(tile.veil){
      if(!this.veilG){ this.veilG = new PIXI.Graphics(); this.container.addChild(this.veilG); }
      this.veilG.clear();
      const r = tileSize*0.5;
      this.veilG.roundRect(-r,-r,r*2,r*2,r*0.3).fill({ color:0x140f21, alpha:0.72 });
      this.veilG.roundRect(-r,-r,r*2,r*2,r*0.3).stroke({ width:2, color:0xffffff, alpha:0.25 });
    }else if(this.veilG){
      this.container.removeChild(this.veilG); this.veilG.destroy(); this.veilG = null;
    }
  }
  playPop(){
    cancelTweensOf(this.container.scale,['x','y']);
    tween(this.container.scale, { x:0.1, y:0.1 }, 180, t=>t*t, null);
    tween(this.container, { rotation: 0.5 }, 180);
  }
  playSpawnPulse(){
    this.container.scale.set(1);
    cancelTweensOf(this.container.scale,['x','y']);
    tween(this.container.scale, { x:1.35, y:1.35 }, 160, easeOutCubic, ()=>{
      tween(this.container.scale, { x:1, y:1 }, 180, easeOutBack);
    });
  }
  playShake(){
    const baseX = this.container.x;
    let i = 0;
    const steps = [ -6,6,-4,4,0 ];
    const step = ()=>{
      if(i>=steps.length) return;
      tween(this.container, { x: baseX+steps[i] }, 60, easeOutCubic, step);
      i++;
    };
    step();
  }
  playLand(){
    cancelTweensOf(this.container.scale,['x','y']);
    this.container.scale.set(1,1);
    tween(this.container.scale, { y:0.68, x:1.22 }, 90, easeOutCubic, ()=>{
      tween(this.container.scale, { y:1.12, x:0.92 }, 110, easeOutCubic, ()=>{
        tween(this.container.scale, { y:1, x:1 }, 120, easeOutBack);
      });
    });
  }
  playSwapStretch(){
    cancelTweensOf(this.container.scale,['x','y']);
    this.container.scale.set(1,1);
    tween(this.container.scale, { x:1.2, y:1.2 }, 90, easeOutCubic, ()=>{
      tween(this.container.scale, { x:1, y:1 }, 140, easeOutBack);
    });
  }
}

/* ============================= PUBLIC API (matches the old DOM module) ============================= */

function setTileTransform(handle, r, c){
  if(!handle) return;
  const target = { x: c*tileSize + tileSize/2, y: r*tileSize + tileSize/2 };
  cancelTweensOf(handle.container, ['x','y']);
  tween(handle.container, target, 280, easeOutBack);
}
function placeTileInstant(handle, r, c){
  handle.container.x = c*tileSize + tileSize/2;
  handle.container.y = r*tileSize + tileSize/2;
}
// Used on window resize: snap size+position immediately, no tween (a tween
// mid-resize would visibly lag behind the new layout).
function resizeTile(handle, r, c){
  if(!handle) return;
  handle.setSize(tileSize*0.94);
  placeTileInstant(handle, r, c);
}

function createTileEl(tile, onPointerDown){
  ensureApp();
  const handle = new TileHandle(tile);
  handle.updateVisual();
  handle.container.eventMode = 'static';
  handle.container.cursor = 'pointer';
  handle.container.on('pointerdown', (e)=>{
    if(!onPointerDown || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    onPointerDown({ clientX: rect.left + e.global.x, clientY: rect.top + e.global.y });
  });
  boardLayer.addChild(handle.container);
  return handle;
}
function refreshTileVisual(tile){
  if(tile.el) tile.el.updateVisual();
}
function removeTileEl(tile){
  if(!tile.el) return;
  const h = tile.el;
  if(h._pulseTicking && app) app.ticker.remove(h._pulseFn);
  cancelTweensOf(h.container);
  cancelTweensOf(h.container.scale);
  if(h.container.parent) h.container.parent.removeChild(h.container);
  h.container.destroy({ children:true });
}
function playLandAnimation(tile){ if(tile.el) tile.el.playLand(); }
function playSwapStretch(tile){ if(tile.el) tile.el.playSwapStretch(); }

function renderFullBoard(rowsArg, colsArg, grid, tilesById, onPointerDown){
  rows = rowsArg; cols = colsArg;
  boardLayer.removeChildren();
  measureTileSize(cols);
  let i = 0;
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const tile = tilesById.get(grid[r][c]);
      const handle = createTileEl(tile, onPointerDown);
      tile.el = handle;
      placeTileInstant(handle, r, c);
      handle.container.scale.set(0.3);
      handle.container.alpha = 0;
      const delay = i*14;
      setTimeout(()=>{
        if(!handle.container.destroyed){
          tween(handle.container.scale, { x:1, y:1 }, 380, easeOutBack);
          tween(handle.container, { alpha:1 }, 260, easeOutCubic);
        }
      }, delay);
      i++;
    }
  }
}

export {
  setBoardEl, getBoardEl, getApp, getReady, measureTileSize, getTileSize, cellCenter, setTileTransform,
  placeTileInstant, resizeTile, createTileEl, refreshTileVisual, renderFullBoard, removeTileEl,
  playLandAnimation, playSwapStretch,
  tween, cancelTweensOf, easeOutBack, easeOutCubic, hexOf,
};
