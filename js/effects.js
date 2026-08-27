/* ============================= JUICE: particles, shake, flash, board life (PixiJS) ============================= */
// GPU-composited particles and glow/bloom filters via the same PIXI stage
// render.js owns (see getApp()), instead of a separate 2D canvas. Screen
// shake, the combo popup, confetti, and the ambient background stay DOM/CSS
// — they're outside the board and cheap either way, no reason to move them.

import * as render from './render.js';

let boardArch, comboPopupEl, confettiLayerEl, ambientBg;
let particleLayer = null;
let flashLayer = null;
let particles = [];

function ensureLayers(){
  const app = render.getApp();
  if(!app || particleLayer) return app;
  particleLayer = new PIXI.Container();
  flashLayer = new PIXI.Graphics();
  app.stage.addChild(particleLayer);
  app.stage.addChild(flashLayer);
  app.ticker.add(stepParticles);
  return app;
}

function init(elements){
  boardArch = elements.boardArch;
  comboPopupEl = elements.comboPopupEl;
  confettiLayerEl = elements.confettiLayerEl;
  ambientBg = elements.ambientBg || document.querySelector('.ambient-bg');
  ensureLayers();
}

function resizeCanvas(){ /* render.js owns renderer sizing via measureTileSize now */ }

function resolveColor(c){ return render.hexOf(c); }

function stepParticles(){
  if(!particles.length) return;
  particles = particles.filter(p=>p.life>0);
  for(const p of particles){
    p.life -= p.decay;
    const alpha = Math.max(0, p.life);
    if(p.kind==='ring'){
      p.radius += p.growth;
      p.g.clear();
      p.g.circle(p.x,p.y,p.radius).stroke({ width:p.width, color:p.color, alpha });
    }else if(p.kind==='beam'){
      p.g.clear();
      p.g.moveTo(p.x1,p.y1).lineTo(p.x2,p.y2).stroke({ width:p.width*Math.max(0.15,alpha), color:p.color, alpha });
    }else{
      p.x += p.vx; p.y += p.vy;
      p.vy += p.gravity||0;
      p.vx *= p.friction; p.vy *= p.friction;
      p.g.clear();
      p.g.circle(p.x,p.y,p.size).fill({ color:p.color, alpha });
    }
    if(p.life<=0 && p.g.parent) p.g.parent.removeChild(p.g);
  }
}

const TIERS = {
  small:  { count:9,  speed:2.4, size:[2,4], decay:0.045 },
  medium: { count:18, speed:3.6, size:[3,6], decay:0.035 },
  large:  { count:30, speed:4.8, size:[3,7], decay:0.028 },
  huge:   { count:46, speed:6.2, size:[4,9], decay:0.022 },
};

function burst(x, y, color, tier){
  const app = ensureLayers();
  if(!app) return;
  color = resolveColor(color);
  const t = TIERS[tier] || TIERS.small;
  for(let i=0;i<t.count;i++){
    const angle = (Math.PI*2*i)/t.count + Math.random()*0.6;
    const speed = t.speed*(0.5+Math.random()*0.8);
    const g = new PIXI.Graphics();
    particleLayer.addChild(g);
    particles.push({
      g, x, y,
      vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed,
      gravity: 0.14, friction: 0.965,
      size: t.size[0] + Math.random()*(t.size[1]-t.size[0]),
      color, life:1, decay: t.decay*(0.8+Math.random()*0.4),
    });
  }
}
function ring(x, y, color, startRadius){
  const app = ensureLayers();
  if(!app) return;
  const g = new PIXI.Graphics();
  particleLayer.addChild(g);
  particles.push({ kind:'ring', g, x, y, radius:startRadius||4, growth:6, width:4, color:resolveColor(color), life:1, decay:0.03 });
}
function beam(x1,y1,x2,y2,color){
  const app = ensureLayers();
  if(!app) return;
  const g = new PIXI.Graphics();
  particleLayer.addChild(g);
  particles.push({ kind:'beam', g, x1,y1,x2,y2, width:6, color:resolveColor(color), life:1, decay:0.05 });
}
function trail(x1,y1,x2,y2,color){
  const app = ensureLayers();
  if(!app) return;
  const g = new PIXI.Graphics();
  particleLayer.addChild(g);
  particles.push({ kind:'beam', g, x1,y1,x2,y2, width:5, color:resolveColor(color), life:1, decay:0.12 });
}
function bloom(x,y,color,tier){
  burst(x,y,color,tier);
  ring(x,y,color,4);
  setTimeout(()=>burst(x,y,color, tier==='huge'?'medium':'small'), 90);
}

// Frostbloom's signature — an expanding sequence of rings radiating from
// the activation point, reading as a spreading crack/shatter wave rather
// than one instant pulse. Purely visual (the tiles it affects are already
// cleared by the time this plays out) — built entirely from the existing
// ring()/burst() primitives, no new particle kind needed.
function frostShatter(x, y, color, ringCount){
  const app = ensureLayers();
  if(!app) return;
  burst(x,y,color,'medium');
  const steps = Math.max(1, ringCount||3);
  for(let i=0;i<=steps;i++){
    setTimeout(()=>ring(x, y, color, 6 + i*16), i*70);
  }
}

// Comet's signature — a streak toward each smart-picked target followed by
// its own small impact burst, staggered slightly so the three hits read as
// a sequence, not one simultaneous blast.
function cometStreak(x0, y0, targets, color){
  const app = ensureLayers();
  if(!app) return;
  (targets||[]).forEach((t,i)=>{
    setTimeout(()=>{
      trail(x0,y0,t.x,t.y,color);
      burst(t.x,t.y,color,'medium');
    }, i*90);
  });
}

/* ---------- screen shake (still the DOM board-arch frame) ---------- */
function shake(magnitude, duration){
  if(!boardArch) return;
  boardArch.classList.add('shaking');
  const start = performance.now();
  function frame(now){
    const t = now-start;
    if(t >= duration){ boardArch.style.transform=''; boardArch.classList.remove('shaking'); return; }
    const decay = 1 - t/duration;
    const dx = (Math.random()*2-1)*magnitude*decay;
    const dy = (Math.random()*2-1)*magnitude*decay;
    boardArch.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ---------- flash / ripple: a real full-board GPU alpha pulse + shockwave rings ---------- */
function flash(color, duration, variant){
  const app = ensureLayers();
  if(!app || !flashLayer) return;
  const hex = resolveColor(color);
  const w = app.renderer.width/(app.renderer.resolution||1), h = app.renderer.height/(app.renderer.resolution||1);
  flashLayer.clear();
  flashLayer.rect(0,0,w,h).fill({ color:hex, alpha:1 });
  flashLayer.alpha = 0;
  render.cancelTweensOf(flashLayer);
  render.tween(flashLayer, { alpha:0.8 }, (duration||420)*0.25, render.easeOutCubic, ()=>{
    render.tween(flashLayer, { alpha:0 }, (duration||420)*0.75, render.easeOutCubic);
  });
  if(variant==='ripple'){
    ring(w/2, h/2, color, 8);
    setTimeout(()=>ring(w/2,h/2,color,8), 90);
  }
}

/* ---------- ambient background reacts to big moments ---------- */
function pulseAmbient(duration){
  if(!ambientBg) return;
  ambientBg.classList.add('charged');
  clearTimeout(pulseAmbient._h);
  pulseAmbient._h = setTimeout(()=>ambientBg.classList.remove('charged'), duration||900);
}

/* ---------- combo popup / confetti (DOM, unchanged) ---------- */
const COMBO_WORDS = ['Blessed!','Grace!','Hallelujah!','Faithful!','Radiant!','Wondrous!','Glory!','Anointed!'];
function comboPopup(n){
  if(!comboPopupEl) return;
  const word = COMBO_WORDS[Math.min(n-2, COMBO_WORDS.length-1)];
  comboPopupEl.textContent = `${word} x${n}`;
  comboPopupEl.classList.remove('show');
  void comboPopupEl.offsetWidth;
  comboPopupEl.classList.add('show');
}
function confettiBurst(){
  if(!confettiLayerEl) return;
  const colors = ['#e6b754','#f0836b','#9668cc','#3fa377','#f8f0df','#d8455f'];
  for(let i=0;i<46;i++){
    const el = document.createElement('div');
    el.className = 'confetto';
    el.style.left = (Math.random()*100)+'vw';
    el.style.background = colors[Math.floor(Math.random()*colors.length)];
    el.style.animationDuration = (2.2+Math.random()*1.6)+'s';
    el.style.animationDelay = (Math.random()*0.4)+'s';
    el.style.borderRadius = Math.random()>0.5 ? '50%' : '2px';
    confettiLayerEl.appendChild(el);
    setTimeout(()=>el.remove(), 4200);
  }
}

/* ---------- idle board life ---------- */
function idleShimmer(tileEls){
  const pool = tileEls.filter(Boolean);
  const n = Math.min(pool.length, 4 + Math.floor(Math.random()*4));
  for(let i=0;i<n;i++){
    const handle = pool[Math.floor(Math.random()*pool.length)];
    if(!handle || !handle.sprite) continue;
    let t = 0;
    const id = setInterval(()=>{
      t += 1;
      const k = Math.sin(t*0.5)*0.5+0.5;
      const v = 255 - Math.round(k*30);
      handle.sprite.tint = (v<<16)|(v<<8)|v;
      if(t>10){ clearInterval(id); handle.sprite.tint = 0xffffff; }
    }, 60);
  }
}
function hintSparkle(handleA, handleB){
  const targets = [handleA, handleB].filter(Boolean);
  const timers = targets.map(h=>{
    let t = 0;
    return setInterval(()=>{
      t += 1;
      const s = 1 + Math.sin(t*0.7)*0.08;
      h.container.scale.set(s);
    }, 45);
  });
  return ()=>{
    timers.forEach(clearInterval);
    targets.forEach(h=>{ if(h && h.container && !h.container.destroyed) h.container.scale.set(1); });
  };
}

export {
  init, resizeCanvas, burst, ring, beam, trail, bloom, shake, flash, pulseAmbient,
  frostShatter, cometStreak,
  comboPopup, confettiBurst, idleShimmer, hintSparkle,
};
