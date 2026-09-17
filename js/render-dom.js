/* ============================= TILE RENDERING — DOM FALLBACK ============================= */
// The last-resort board renderer, used when there is no usable canvas at
// all: PixiJS failed to load or construct, or its own WebGL *and* Canvas2D
// backends both failed to initialise (see render.js's boot ladder). Before
// this existed, any of those produced a silently empty board — the arch
// frame and grid lines drew from CSS, the tiles never appeared, and nothing
// told the player anything was wrong.
//
// It deliberately implements the *same handle contract* render.js's Pixi
// TileHandle does, so none of the calling code changes shape:
//   handle.container -> { x, y, rotation, alpha, zIndex, scale:{x,y} }
//   handle.sprite    -> { scale:{ x, y, set(s) } }   (the breathing channel)
//   handle.setSize(px) / .updateVisual() / .classList.add|remove(name)
//   handle.playPop|playSpawnPulse|playShake|playLand|playSwapStretch()
// Because `container` is a plain object of numbers, render.js's tween
// runner, setTileTransform(), the drag-follow helpers and the breathing
// ticker all drive these tiles unmodified — the only per-frame extra is
// flush(), which writes those numbers out as one CSS transform.
//
// Fidelity is deliberately lower than the Pixi path (no particles, no glow
// bloom, no procedural gem facets — effects.js no-ops on its own when
// render.getApp() returns null). Every *rule* still works: matching,
// cascades, specials, veils, drag-to-swap, the lot. A plain board you can
// play beats a beautiful one you can't.

import { SYMBOLS } from './content.js';
import { iconSVG } from './icons.js';

class DomTileHandle{
  constructor(tile, boardEl, onPointerDown){
    this.tile = tile;
    this.size = 0;
    this.el = document.createElement('div');
    this.el.className = 'dom-tile';
    this.el.innerHTML = `<span class="dt-face"></span>`;
    this.face = this.el.firstElementChild;

    // Mirrors PIXI.Container's transform surface closely enough that
    // render.js's tween()/cancelTweensOf() drive it without knowing which
    // backend it got.
    this.container = { x:0, y:0, rotation:0, alpha:1, zIndex:0, scale:{ x:1, y:1 }, destroyed:false };
    // The ambient "breathing" pulse lives on its own scale channel exactly
    // as it does on the Pixi path, so it never fights the one-shot effects
    // animating container.scale.
    this.sprite = { scale:{ x:1, y:1, set:(s)=>{ this.sprite.scale.x = this.sprite.scale.y = s; } } };
    this._baseScale = 1;
    this._breathePhase = Math.random();

    this.classList = {
      add: (name)=>{
        if(name==='pop') this.playPop();
        else if(name==='spawn-special') this.playSpawnPulse();
        else if(name==='shake') this.playShake();
        else this.el.classList.add(name); // 'selected' and friends are real CSS here
      },
      remove: (name)=>{ if(name) this.el.classList.remove(name); },
    };

    if(onPointerDown){
      this.el.addEventListener('pointerdown', (e)=>onPointerDown({ clientX:e.clientX, clientY:e.clientY }));
    }
    boardEl.appendChild(this.el);
  }

  setSize(size){
    this.size = size;
    this.el.style.width = this.el.style.height = size + 'px';
  }

  updateVisual(){
    const tile = this.tile;
    const sym = SYMBOLS[tile.type] || SYMBOLS[0];
    this.face.style.setProperty('--dt-color', sym.color);
    if(this._iconType !== tile.type){
      this.face.innerHTML = iconSVG(tile.type);
      this._iconType = tile.type;
    }
    const kind = tile.special ? tile.special.kind : null;
    if(this._specialKind !== kind){
      if(this._specialKind) this.el.classList.remove('dt-' + this._specialKind);
      this.el.classList.toggle('dt-special', !!kind);
      if(kind) this.el.classList.add('dt-' + kind);
      this._specialKind = kind;
    }
    this.el.classList.toggle('dt-veiled', !!tile.veil);
  }

  // One CSS write per tile per frame. container.x/y are the tile's *center*
  // (Pixi anchors at 0.5), so the translate subtracts half a tile; rotate
  // and scale then apply about the element's own center.
  flush(){
    const c = this.container;
    const half = this.size/2;
    const sx = c.scale.x * this.sprite.scale.x;
    const sy = c.scale.y * this.sprite.scale.y;
    this.el.style.transform =
      `translate3d(${(c.x-half).toFixed(2)}px, ${(c.y-half).toFixed(2)}px, 0)` +
      ` rotate(${c.rotation.toFixed(3)}rad) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
    if(this._alpha !== c.alpha){ this.el.style.opacity = c.alpha; this._alpha = c.alpha; }
    if(this._z !== c.zIndex){ this.el.style.zIndex = c.zIndex; this._z = c.zIndex; }
  }

  destroy(){
    this.container.destroyed = true;
    if(this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

export { DomTileHandle };
