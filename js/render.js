/* ============================= TILE RENDERING (WebGL / PixiJS) ============================= */
// Owns the board's actual pixels: a PIXI.Application mounted into the
// existing #fx-canvas element (reusing its CSS positioning — no DOM/layout
// changes needed), tile textures generated procedurally at runtime from
// js/icons.js's path data (rasterized once via the browser's native SVG
// support, then GPU-cached), and tween-driven motion instead of CSS
// transitions. engine.js still treats what this returns as an opaque `el`
// handle with a `.classList.add/remove(name)` surface, matching the old
// DOM-based module's contract, so the match-rules code barely changed.
//
// Rendering is a *ladder*, not a single path — the board has to appear on
// every device that can open the page, including the weak, old and
// memory-starved ones this game will land on at scale:
//
//   1. WebGL (PixiJS)   — the full-fidelity path: filters, particles, glow.
//   2. Canvas2D (PixiJS)— same scene graph, software-rasterized. Used when
//                         WebGL is unavailable or its init throws.
//   3. DOM tiles        — js/render-dom.js, used when there is no usable
//                         canvas at all (PixiJS itself failed to load, or
//                         both of its backends failed). Plain, but playable.
//
// Plus one runtime recovery path: a WebGL context that is *lost* mid-level
// (routine on low-memory Android when the app is backgrounded, or under
// GPU driver pressure) used to blank the board permanently and silently —
// see handleContextLoss() for why Pixi's own handler doesn't save us there.

import { SYMBOLS } from './content.js';
import { iconSVG } from './icons.js';
import { DomTileHandle } from './render-dom.js';

const MODE_WEBGL = 'webgl';
const MODE_CANVAS = 'canvas';
const MODE_DOM = 'dom';

let app = null;
let boardEl = null;
let canvasEl = null;
let boardLayer = null;
let tileSize = 40;
let cols = 8, rows = 8;
let mode = null;             // null until the boot ladder settles
let booted = false;          // ensureApp() has run its one-time boot
const baseTextures = new Map(); // type index -> PIXI.Texture (shared, reused per tile)
const reduceMotion = typeof window!=='undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let readyPromise = null;
let noticeFn = null;         // set by screens.js — how a degraded mode reaches the player
let repaintFn = null;        // set by engine.js — how we ask for a full board redraw

/* ============================= INIT / RENDER LADDER ============================= */

function pixiInitOptions(extra){
  return Object.assign({
    canvas: canvasEl,
    width: 400, height: 400,
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(2, window.devicePixelRatio||1),
    autoDensity: true,
  }, extra||{});
}

// A canvas element can only ever hand out one *kind* of context for its
// whole life — once it has been a WebGL surface, getContext('2d') on it
// returns null forever. So every re-init (Canvas2D retry, post-context-loss
// rebuild) has to start from a genuinely fresh element, not the old one.
function freshCanvasEl(){
  const old = document.getElementById('fx-canvas');
  if(!old) return null;
  const next = document.createElement('canvas');
  next.id = old.id;
  next.className = old.className;
  old.parentNode.replaceChild(next, old);
  canvasEl = next;
  return next;
}

async function bootPixi(){
  try{
    await app.init(pixiInitOptions());
  }catch(e){
    // Pixi picks WebGL first and falls back to its own Canvas2D renderer on
    // its own; landing here means even that didn't come up. Retry once,
    // explicitly asking for Canvas2D on a clean canvas — on some old
    // WebViews the first attempt leaves the element poisoned.
    try{ app.destroy({ removeView:false }); }catch(_){}
    freshCanvasEl();
    app = new PIXI.Application();
    await app.init(pixiInitOptions({ preference:'canvas' }));
  }
  mode = (app.renderer && app.renderer.name === 'webgl') ? MODE_WEBGL : MODE_CANVAS;
  app.stage.addChild(boardLayer);
  watchForContextLoss();
  await buildAllTextures();
}

function ensureApp(){
  if(booted) return app;
  booted = true;
  canvasEl = document.getElementById('fx-canvas');
  // PixiJS is a ~800KB classic script (see index.html). On a flaky mobile
  // connection it can simply never arrive, and `new PIXI.Application()`
  // then throws a ReferenceError straight through startLevel() — which is
  // one of the ways the board used to end up blank with nothing logged.
  if(typeof PIXI === 'undefined' || !PIXI.Application){
    readyPromise = Promise.resolve(useDomFallback());
    return null;
  }
  try{
    app = new PIXI.Application();
    boardLayer = new PIXI.Container();
  }catch(e){
    readyPromise = Promise.resolve(useDomFallback());
    return null;
  }
  readyPromise = bootPixi().catch(()=>{ useDomFallback(); });
  return app;
}

// Last rung of the ladder: no usable canvas, so tiles become DOM elements.
function useDomFallback(){
  mode = MODE_DOM;
  app = null;
  boardLayer = null;
  baseTextures.clear();
  // .fx-canvas sits above #board at z-index 25 with touch-action:none — left
  // visible it would swallow every tap meant for a DOM tile.
  const cv = document.getElementById('fx-canvas');
  if(cv) cv.style.display = 'none';
  if(boardEl) boardEl.classList.add('dom-board');
  notify('Simple graphics mode — this device could not start the visual effects.');
}

function notify(msg){ if(noticeFn) try{ noticeFn(msg); }catch(_){} }
function setRendererNotice(fn){ noticeFn = fn; }
function setRepaintHandler(fn){ repaintFn = fn; }
function getRenderMode(){ return mode; }

/* ---------- WebGL context loss ---------- */
// A lost context is the single most common way a match-3 board goes blank
// on a real low-end phone: background the app, take a call, come back, and
// the GPU has reclaimed the context. Pixi installs its own handler, but it
// only ever asks for a restore when *it* forced the loss
// (`_contextLossForced`); a loss the driver or OS initiated is
// preventDefault()ed and then nothing further happens, so the canvas stays
// blank for the rest of the session.
//
// We rebuild on Canvas2D rather than trying to restore WebGL, for two
// reasons: a restored context comes back with every texture blank, because
// ours are renderer.generateTexture() render targets with no CPU-side
// source to re-upload; and a device that lost the context once under memory
// pressure is likely to do it again. Canvas2D cannot be lost, so the board
// stays up for the rest of the session. It is the same renderer devices
// without WebGL already use, so it is a well-travelled path, not a special
// case that only runs after a failure.
let contextWatched = false;
let recovering = false;
function watchForContextLoss(){
  if(contextWatched || !canvasEl || mode !== MODE_WEBGL) return;
  contextWatched = true;
  canvasEl.addEventListener('webglcontextlost', handleContextLoss, false);
}
function handleContextLoss(e){
  if(e && e.preventDefault) e.preventDefault();
  if(recovering) return;
  recovering = true;
  rebuildOnCanvas2D().catch(()=>{ useDomFallback(); if(repaintFn) repaintFn(); });
}
async function rebuildOnCanvas2D(){
  const old = app;
  app = null;
  boardLayer = null;
  baseTextures.clear();
  liveHandles.clear();
  activeTweens.clear();
  tickerAttached = false;
  breatheTickerOn = false;
  contextWatched = false;
  try{ old.destroy({ removeView:false }, { children:true, texture:true }); }catch(_){}

  freshCanvasEl();
  app = new PIXI.Application();
  boardLayer = new PIXI.Container();
  await app.init(pixiInitOptions({ preference:'canvas' }));
  mode = MODE_CANVAS;
  app.stage.addChild(boardLayer);
  await buildAllTextures();
  recovering = false;
  // Every tile handle died with the old renderer — engine.js owns the board
  // state, so it is the only thing that can hand us a live board back.
  if(repaintFn) repaintFn();
  notify('Graphics restarted in a lighter mode — your level is exactly where you left it.');
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

  // Halo Bomb — the 6-match tier, deliberately the single most premium tile
  // face in the game. A radiant sunburst rather than colorbomb's swirl, so
  // the rarest, most rewarding piece is instantly recognizable even before
  // its glow ring kicks in.
  const ha = new PIXI.Container();
  const hg = new PIXI.Graphics();
  const haloBase = hexOf('var(--halo-glow)');
  hg.circle(64,64,62).fill({ color: mixHex(0xffffff, haloBase, 0.55) });
  for(let i=0;i<10;i++){
    const ang = (Math.PI*2*i)/10;
    const x1 = 64+Math.cos(ang)*20, y1 = 64+Math.sin(ang)*20;
    const x2 = 64+Math.cos(ang)*60, y2 = 64+Math.sin(ang)*60;
    hg.moveTo(x1,y1).lineTo(x2,y2).stroke({ width:5, color:0xffffff, alpha:0.5 });
  }
  hg.circle(64,64,26).fill({ color:0xffffff, alpha:0.75 });
  ha.addChild(hg);
  try{ baseTextures.set('halo', app.renderer.generateTexture(ha)); }catch(e){}
  ha.destroy({ children:true });
}

/* ============================= BOARD SIZING ============================= */

function setBoardEl(el){
  boardEl = el;
  ensureApp();
  if(mode === MODE_DOM) boardEl.classList.add('dom-board');
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

/* ============================= FRAME CLOCK ============================= */
// Pixi's ticker when there's a Pixi app, a plain rAF loop when there isn't
// (DOM fallback) — so tweening, breathing and the DOM flush all run off one
// abstraction instead of every caller checking which renderer is live.

const rafCallbacks = new Set();
let rafHandle = 0;
function rafLoop(){
  rafHandle = requestAnimationFrame(rafLoop);
  rafCallbacks.forEach(fn=>{ try{ fn(); }catch(_){} });
}
function onTick(fn){
  if(app && app.ticker){ app.ticker.add(fn); return; }
  rafCallbacks.add(fn);
  if(!rafHandle) rafHandle = requestAnimationFrame(rafLoop);
}
function offTick(fn){
  if(app && app.ticker){ try{ app.ticker.remove(fn); }catch(_){} }
  rafCallbacks.delete(fn);
}

/* ============================= TWEENING ============================= */
// A tiny hand-rolled tween runner driven by the frame clock — no extra
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
  if(tickerAttached) return;
  tickerAttached = true;
  onTick(()=>{
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

/* ============================= AMBIENT "BREATHING" ============================= */
// Every tile at rest gets a faint, alive-feeling pulse — a soft double-beat
// rhythm (a quick "lub", a smaller "dub", then a rest) rather than a plain
// sine wobble, so it reads as organic rather than mechanical, and delicate
// enough that it's a texture, not a distraction. Deliberately applied to
// the *sprite's* own scale, not the container's — the container's scale is
// what pop/spawn/land/swap-stretch animate, so keeping this on a separate
// transform channel means the ambient pulse and any one-shot effect never
// fight over the same number. Skipped entirely for prefers-reduced-motion,
// and paused per-tile while it's actively being dragged.
//
// The same loop also flushes DOM-fallback tiles (a no-op on the Pixi path),
// so those tiles get their one CSS transform write per frame from the one
// place that already walks every live handle.
const liveHandles = new Set();
const BREATHE_PERIOD = 1.8; // seconds
const BREATHE_AMOUNT = 0.035; // max scale bump — subtle on purpose
function heartbeatCurve(u){
  const lub = Math.max(0, 1 - Math.abs((u-0.08)/0.07));
  const dub = Math.max(0, 1 - Math.abs((u-0.24)/0.09)) * 0.6;
  return Math.max(lub, dub);
}
let breatheTickerOn = false;
function ensureBreatheTicker(){
  if(breatheTickerOn) return;
  breatheTickerOn = true;
  onTick(()=>{
    const t = performance.now()/1000;
    liveHandles.forEach(h=>{
      if(!reduceMotion && h._dragBaseX==null){ // lifted for a drag — let the drag read clearly instead
        const u = (((t*(1/BREATHE_PERIOD)) + h._breathePhase) % 1);
        const s = (h._baseScale||1) * (1 + heartbeatCurve(u)*BREATHE_AMOUNT);
        h.sprite.scale.set(s);
      }
      if(h.flush) h.flush();
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
  if(kind==='comet') return hexOf('var(--comet-glow)');
  if(kind==='frostbloom') return hexOf('var(--frostbloom-glow)');
  if(kind==='halo') return hexOf('var(--halo-glow)');
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
    this._breathePhase = Math.random(); // own offset so tiles don't beat in unison
    this._baseScale = 1;
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
    // The breathing ticker multiplies on top of whatever scale actually
    // fits the icon to the current tile size — capture it here rather than
    // hardcoding, so it stays correct across resizes.
    this._baseScale = this.sprite.scale.x;
  }
  updateVisual(){
    const tile = this.tile;
    // Color Bomb and Halo Bomb get their own dedicated base texture (a
    // premium tile face replacing the gem base entirely); Comet/Frostbloom
    // keep the matched symbol's own face and rely on their glow ring to
    // read as special — they're "this symbol, empowered," not a new object.
    const specialTexKey = tile.special && (tile.special.kind==='colorbomb' || tile.special.kind==='halo') ? tile.special.kind : null;
    const tex = specialTexKey ? baseTextures.get(specialTexKey) : baseTextures.get(tile.type);
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
        onTick(this._pulseFn = ()=>{
          if(!this.container.parent){ offTick(this._pulseFn); this._pulseTicking=false; return; }
          this._pulseT += 0.06;
          this.glow.alpha = 0.6 + Math.sin(this._pulseT)*0.4;
        });
      }
    }else if(this._pulseTicking){
      offTick(this._pulseFn); this._pulseTicking = false; this.glow.alpha = 1;
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
}

// The one-shot motion vocabulary is identical on both backends — it only
// ever animates numbers on `handle.container` — so it lives once here and
// is shared onto the DOM tile class rather than written out twice.
const TILE_MOTION = {
  playPop(){
    cancelTweensOf(this.container.scale,['x','y']);
    tween(this.container.scale, { x:0.1, y:0.1 }, 180, t=>t*t, null);
    tween(this.container, { rotation: 0.5 }, 180);
  },
  playSpawnPulse(){
    this.container.scale.x = this.container.scale.y = 1;
    cancelTweensOf(this.container.scale,['x','y']);
    tween(this.container.scale, { x:1.35, y:1.35 }, 160, easeOutCubic, ()=>{
      tween(this.container.scale, { x:1, y:1 }, 180, easeOutBack);
    });
  },
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
  },
  playLand(){
    cancelTweensOf(this.container.scale,['x','y']);
    this.container.scale.x = this.container.scale.y = 1;
    tween(this.container.scale, { y:0.68, x:1.22 }, 90, easeOutCubic, ()=>{
      tween(this.container.scale, { y:1.12, x:0.92 }, 110, easeOutCubic, ()=>{
        tween(this.container.scale, { y:1, x:1 }, 120, easeOutBack);
      });
    });
  },
  playSwapStretch(){
    cancelTweensOf(this.container.scale,['x','y']);
    this.container.scale.x = this.container.scale.y = 1;
    tween(this.container.scale, { x:1.2, y:1.2 }, 90, easeOutCubic, ()=>{
      tween(this.container.scale, { x:1, y:1 }, 140, easeOutBack);
    });
  },
};
Object.assign(TileHandle.prototype, TILE_MOTION);
Object.assign(DomTileHandle.prototype, TILE_MOTION);

/* ============================= PUBLIC API (matches the old DOM module) ============================= */

function setTileTransform(handle, r, c){
  if(!handle) return;
  const target = { x: c*tileSize + tileSize/2, y: r*tileSize + tileSize/2 };
  cancelTweensOf(handle.container, ['x','y']);
  // This is the function that sends a tile to its one authoritative grid
  // position, whether that's a normal cascade/refill move or a swap
  // committing straight out of a drag — so it's also the right place to
  // drop the "currently being dragged" lift (z-order + base-offset
  // bookkeeping) regardless of which path got it here.
  handle._dragBaseX = handle._dragBaseY = null;
  handle.container.zIndex = 0;
  tween(handle.container, target, 280, easeOutBack);
}
function placeTileInstant(handle, r, c){
  handle.container.x = c*tileSize + tileSize/2;
  handle.container.y = r*tileSize + tileSize/2;
}
// Same cleanup setTileTransform() does (cancel any in-flight tween, drop
// the drag lift/base bookkeeping), but places the tile instantly instead
// of tweening there. That distinction matters specifically right before
// triggering a shake (playShake(), see its own comment): shake reads the
// container's *current* position synchronously as the point to wiggle
// around and return to. Pair it with setTileTransform() — whose tween
// hasn't advanced anywhere yet at the instant shake reads it — and shake
// captures the pre-tween (wrong) position, then outlasts and wins over that
// tween (playShake never calls cancelTweensOf, so nothing stops it),
// permanently freezing the tile there instead of at its real cell.
// Calling this first means shake always captures the *true* home position.
function snapTileHome(handle, r, c){
  if(!handle) return;
  cancelTweensOf(handle.container, ['x','y']);
  handle._dragBaseX = handle._dragBaseY = null;
  handle.container.zIndex = 0;
  placeTileInstant(handle, r, c);
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
  let handle;
  if(mode === MODE_DOM){
    handle = new DomTileHandle(tile, boardEl, onPointerDown);
    handle.setSize(tileSize*0.94);
    handle.updateVisual();
  }else{
    handle = new TileHandle(tile);
    handle.updateVisual();
    handle.container.eventMode = 'static';
    handle.container.cursor = 'pointer';
    handle.container.on('pointerdown', (e)=>{
      if(!onPointerDown || !canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      onPointerDown({ clientX: rect.left + e.global.x, clientY: rect.top + e.global.y });
    });
    boardLayer.addChild(handle.container);
  }
  liveHandles.add(handle);
  ensureBreatheTicker();
  return handle;
}
function refreshTileVisual(tile){
  if(tile.el) tile.el.updateVisual();
}
function destroyHandle(h){
  liveHandles.delete(h);
  if(h._pulseTicking) offTick(h._pulseFn);
  cancelTweensOf(h.container);
  cancelTweensOf(h.container.scale);
  if(h.destroy){ h.destroy(); return; } // DOM handle owns its own teardown
  if(h.container.parent) h.container.parent.removeChild(h.container);
  h.container.destroy({ children:true });
}
function removeTileEl(tile){
  if(!tile.el) return;
  destroyHandle(tile.el);
}
function playLandAnimation(tile){ if(tile.el) tile.el.playLand(); }
function playSwapStretch(tile){ if(tile.el) tile.el.playSwapStretch(); }

/* ---------- free drag-follow ---------- */
// The tile the player is pressing tracks their finger/cursor live instead
// of only reacting once the gesture ends — press, drag, see it lean toward
// the neighbor you're aiming at, release to either commit (attemptSwap's
// own setTileTransform call takes over seamlessly from wherever the drag
// left it) or spring back if it didn't go far enough / wasn't a legal move.
function beginTileDrag(handle){
  if(!handle) return;
  cancelTweensOf(handle.container, ['x','y']);
  handle._dragBaseX = handle.container.x;
  handle._dragBaseY = handle.container.y;
  handle.container.zIndex = 10; // stay above neighbors while lifted
  if(handle.container.parent) handle.container.parent.sortableChildren = true;
}
function updateTileDrag(handle, offsetX, offsetY){
  if(!handle || handle._dragBaseX==null) return;
  handle.container.x = handle._dragBaseX + offsetX;
  handle.container.y = handle._dragBaseY + offsetY;
}
function endTileDragSnapBack(handle){
  if(!handle || handle._dragBaseX==null) return;
  const target = { x: handle._dragBaseX, y: handle._dragBaseY };
  handle._dragBaseX = handle._dragBaseY = null;
  handle.container.zIndex = 0;
  tween(handle.container, target, 260, easeOutBack);
}

// `animate` is the staggered deal-in every level opens with. A repaint
// triggered by renderer recovery passes false: the player is mid-level and
// wants their board back this frame, not re-dealt over a second.
function renderFullBoard(rowsArg, colsArg, grid, tilesById, onPointerDown, animate){
  rows = rowsArg; cols = colsArg;
  const deal = animate !== false;
  // Every handle from the previous board dies here. Without this they stayed
  // in liveHandles for the rest of the session — the breathing ticker kept
  // walking destroyed tiles, and the leak grew by a whole board per level,
  // which is exactly the memory pressure that costs a weak device its
  // WebGL context in the first place.
  liveHandles.forEach(h=>destroyHandle(h));
  liveHandles.clear();
  if(boardLayer) boardLayer.removeChildren();
  measureTileSize(cols);
  let i = 0;
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const tile = tilesById.get(grid[r][c]);
      const handle = createTileEl(tile, onPointerDown);
      tile.el = handle;
      placeTileInstant(handle, r, c);
      if(!deal) continue;
      handle.container.scale.x = handle.container.scale.y = 0.3;
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
  snapTileHome, placeTileInstant, resizeTile, createTileEl, refreshTileVisual, renderFullBoard, removeTileEl,
  playLandAnimation, playSwapStretch,
  beginTileDrag, updateTileDrag, endTileDragSnapBack,
  tween, cancelTweensOf, easeOutBack, easeOutCubic, hexOf,
  setRendererNotice, setRepaintHandler, getRenderMode,
};
