/* ============================= SPLASH FX (WASM + WebGL) ============================= */
// The splash screen's particle field is real physics, not CSS keyframes:
// simulation runs in compiled C++ (native/particles.cpp -> WebAssembly,
// vendored at js/vendor/particles.{js,wasm}), stepped once per frame, and
// JS reads the results straight out of WASM linear memory via typed-array
// views — no per-particle marshalling across the boundary. Rendering is
// real WebGL (PixiJS, already vendored for the board) with an actual GPU
// bloom pass on the emblem-orbiting particles, not a box-shadow.
//
// Scope: this module owns exactly the particle canvas layered behind/
// around the splash screen's existing DOM content (title, buttons, the
// emblem rings). It doesn't replace that DOM — menus stay HTML for the
// same reason every shipped browser game keeps its UI chrome in the host
// language: it's simply the right tool for accessible, responsive layout.
// What changes is that the *effects* are now a compiled physics core
// driving the GPU, not a browser layout engine approximating motion.

const reduceMotion = typeof window!=='undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let app = null;
let canvasEl = null;
let wasmModule = null;
let emberLayer = null; // most particles — plain additive sprites, no filter (cheap)
let orbitLayer = null; // the small emblem-orbiting subset — this is the only layer that pays for Bloom
let sprites = []; // pooled PIXI.Sprite, one per simulated particle, index-aligned with the WASM arrays
let softTexture = null;
let running = false;
let readyPromise = null;

function loadWasm(){
  return new Promise((resolve) => {
    if(typeof window.createParticlesModule !== 'function'){ resolve(null); return; }
    window.createParticlesModule().then(mod => resolve(mod)).catch(()=>resolve(null));
  });
}

function buildSoftTexture(){
  // One shared soft-glow circle, rasterized once and reused for every
  // particle sprite (a texture atlas of one) — cheap to move/scale/tint
  // per instance, the standard way real particle systems avoid redrawing
  // vector shapes every frame.
  const g = new PIXI.Graphics();
  const r = 32;
  g.circle(r, r, r).fill({ color: 0xffffff, alpha: 1 });
  const tex = app.renderer.generateTexture({
    target: g,
    resolution: 2,
    antialias: true,
  });
  g.destroy();
  return tex;
}

async function init(canvas){
  if(app) return readyPromise;
  canvasEl = canvas;
  app = new PIXI.Application();
  emberLayer = new PIXI.Container();
  orbitLayer = new PIXI.Container();

  readyPromise = Promise.all([
    app.init({
      canvas: canvasEl,
      width: canvasEl.clientWidth||420, height: canvasEl.clientHeight||860,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio||1),
      autoDensity: true,
    }),
    loadWasm(),
  ]).then(([, mod]) => {
    wasmModule = mod;
    if(!wasmModule) return; // WASM unavailable (unsupported browser) — screen still works, just static
    app.stage.addChild(emberLayer);
    app.stage.addChild(orbitLayer);
    softTexture = buildSoftTexture();

    wasmModule._fm_init((Date.now() & 0xffffffff) >>> 0);
    const count = wasmModule._fm_count();
    const kinds = new Uint8Array(wasmModule.HEAPU8.buffer, wasmModule._fm_get_kind(), count);
    for(let i=0;i<count;i++){
      const s = new PIXI.Sprite(softTexture);
      s.anchor.set(0.5);
      s.blendMode = 'add'; // additive — overlapping particles brighten instead of muddying, real light-like compositing
      // Split by kind at creation time (kind is fixed per slot for the
      // simulation's whole lifetime — see native/particles.cpp) so each
      // sprite is parented once, never reshuffled between layers on a
      // respawn. Only the small orbit layer carries the Bloom filter — a
      // real, expensive multi-pass GPU effect is worth it around the
      // emblem specifically, not worth paying per-pixel for all ~260
      // particles including the ones scattered across the whole screen.
      (kinds[i]===1 ? orbitLayer : emberLayer).addChild(s);
      sprites.push(s);
    }

    try{
      orbitLayer.filters = [ new PIXI.filters.BloomFilter({ strength: 1.8 }) ];
    }catch(e){ /* filter unavailable — orbit particles still render, just without the bloom pass */ }

    app.ticker.add(tick);
  }).catch(()=>{});

  return readyPromise;
}

function hueToHex(h){
  // Small HSL->RGB, s=70% l=62% fixed — matches the game's warm, saturated
  // palette without needing per-particle color logic on the C++ side.
  const s = 0.7, l = 0.62;
  const c = (1 - Math.abs(2*l - 1)) * s;
  const x = c * (1 - Math.abs((h/60) % 2 - 1));
  const m = l - c/2;
  let r,g,b;
  if(h<60){r=c;g=x;b=0;} else if(h<120){r=x;g=c;b=0;} else if(h<180){r=0;g=c;b=x;}
  else if(h<240){r=0;g=x;b=c;} else if(h<300){r=x;g=0;b=c;} else {r=c;g=0;b=x;}
  const R = Math.round((r+m)*255), G = Math.round((g+m)*255), B = Math.round((b+m)*255);
  return (R<<16)|(G<<8)|B;
}

function tick(ticker){
  if(!wasmModule || !running) return;
  const dt = Math.min(0.05, ticker.deltaMS/1000);
  wasmModule._fm_step(dt);

  const count = wasmModule._fm_count();
  const xs = new Float32Array(wasmModule.HEAPF32.buffer, wasmModule._fm_get_x(), count);
  const ys = new Float32Array(wasmModule.HEAPF32.buffer, wasmModule._fm_get_y(), count);
  const sizes = new Float32Array(wasmModule.HEAPF32.buffer, wasmModule._fm_get_size(), count);
  const alphas = new Float32Array(wasmModule.HEAPF32.buffer, wasmModule._fm_get_alpha(), count);
  const hues = new Float32Array(wasmModule.HEAPF32.buffer, wasmModule._fm_get_hue(), count);
  const kinds = new Uint8Array(wasmModule.HEAPU8.buffer, wasmModule._fm_get_kind(), count);

  for(let i=0;i<count;i++){
    const s = sprites[i];
    if(!s) continue;
    s.x = xs[i]; s.y = ys[i];
    const baseSize = sizes[i] * (kinds[i]===1 ? 5.5 : 3.2); // orbit motes render larger — they're the emblem's "energy", meant to read clearly against the bloom
    s.width = s.height = baseSize;
    s.alpha = alphas[i] * (kinds[i]===1 ? 0.9 : 0.55);
    s.tint = hueToHex(hues[i]);
  }
}

function resize(){
  if(!app || !canvasEl || !wasmModule) return;
  const w = canvasEl.clientWidth, h = canvasEl.clientHeight;
  if(w<=0 || h<=0) return;
  try{ app.renderer.resize(w, h); }catch(e){}
  const emblem = document.querySelector('.brand-emblem');
  let ex = w*0.5, ey = h*0.32;
  if(emblem){
    const r = emblem.getBoundingClientRect();
    const cr = canvasEl.getBoundingClientRect();
    ex = r.left - cr.left + r.width/2;
    ey = r.top - cr.top + r.height/2;
  }
  wasmModule._fm_configure(ex, ey, w, h);
}

function start(){
  if(reduceMotion) return; // simulation never steps — nothing to disable elsewhere
  running = true;
  resize();
}
function stop(){ running = false; }

export { init, start, stop, resize };
