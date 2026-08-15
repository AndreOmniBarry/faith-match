/* ============================= JUICE: particles, shake, flash, board life ============================= */
// The "it needs to feel alive" layer. Self-contained canvas particle system
// (no libraries — keeps the app light for a phone webview), plus screen
// shake, a radial flash for the biggest activations, and idle-time board
// life (shimmer + a hint sparkle) so the board never looks dead between moves.

let canvas, ctx, boardArch, flashLayer, comboPopupEl, confettiLayerEl;
let particles = [];
let rafId = null;

// Canvas fillStyle/strokeStyle can't parse `var(--x)` — resolve to the
// actual computed color. DOM elements (flash layer) can keep the raw var()
// string since CSS resolves nested custom properties natively.
function resolveColor(c){
  if(typeof c==='string' && c.startsWith('var(')){
    const name = c.slice(4, c.endsWith(')') ? -1 : undefined).split(',')[0].trim();
    const resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return resolved || '#f4d78c';
  }
  return c;
}

function init(elements){
  canvas = elements.canvas;
  ctx = canvas.getContext('2d');
  boardArch = elements.boardArch;
  flashLayer = elements.flashLayer;
  comboPopupEl = elements.comboPopupEl;
  confettiLayerEl = elements.confettiLayerEl;
}

function resizeCanvas(){
  if(!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio||1);
  canvas.width = rect.width*dpr;
  canvas.height = rect.height*dpr;
  canvas.style.width = rect.width+'px';
  canvas.style.height = rect.height+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
}

function ensureLoop(){
  if(rafId) return;
  const step = ()=>{
    ctx.clearRect(0,0,canvas.width,canvas.height);
    particles = particles.filter(p=>p.life > 0);
    for(const p of particles){
      p.life -= p.decay;
      p.x += p.vx; p.y += p.vy;
      p.vy += p.gravity||0;
      p.vx *= p.friction!=null?p.friction:0.98;
      p.vy *= p.friction!=null?p.friction:0.98;
      const alpha = Math.max(0, p.life);
      ctx.globalAlpha = alpha;
      if(p.kind==='ring'){
        p.radius += p.growth;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.width;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI*2);
        ctx.stroke();
      }else if(p.kind==='beam'){
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x1,p.y1); ctx.lineTo(p.x2,p.y2);
        ctx.stroke();
      }else{
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    if(particles.length){
      rafId = requestAnimationFrame(step);
    }else{
      rafId = null;
    }
  };
  rafId = requestAnimationFrame(step);
}

const TIERS = {
  small:  { count:9,  speed:2.2, size:[2,4], decay:0.045 },
  medium: { count:18, speed:3.4, size:[3,6], decay:0.035 },
  large:  { count:30, speed:4.6, size:[3,7], decay:0.028 },
  huge:   { count:46, speed:6.0, size:[4,9], decay:0.022 },
};

function burst(x, y, color, tier){
  if(!canvas) return;
  color = resolveColor(color);
  const t = TIERS[tier] || TIERS.small;
  for(let i=0;i<t.count;i++){
    const angle = (Math.PI*2*i)/t.count + Math.random()*0.6;
    const speed = t.speed*(0.5+Math.random()*0.8);
    particles.push({
      x, y,
      vx: Math.cos(angle)*speed,
      vy: Math.sin(angle)*speed,
      gravity: 0.12,
      friction: 0.965,
      size: t.size[0] + Math.random()*(t.size[1]-t.size[0]),
      color,
      life: 1,
      decay: t.decay*(0.8+Math.random()*0.4),
    });
  }
  ensureLoop();
}

function ring(x, y, color, startRadius){
  if(!canvas) return;
  particles.push({ kind:'ring', x, y, radius:startRadius||4, growth:5.5, width:4, color:resolveColor(color), life:1, decay:0.03 });
  ensureLoop();
}

function beam(x1, y1, x2, y2, color){
  if(!canvas) return;
  particles.push({ kind:'beam', x1,y1,x2,y2, width:6, color:resolveColor(color), life:1, decay:0.05 });
  ensureLoop();
}

function shake(magnitude, duration){
  if(!boardArch) return;
  boardArch.classList.add('shaking');
  const start = performance.now();
  function frame(now){
    const t = now-start;
    if(t >= duration){
      boardArch.style.transform = '';
      boardArch.classList.remove('shaking');
      return;
    }
    const decay = 1 - t/duration;
    const dx = (Math.random()*2-1)*magnitude*decay;
    const dy = (Math.random()*2-1)*magnitude*decay;
    boardArch.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function flash(color, duration){
  if(!flashLayer) return;
  flashLayer.style.setProperty('--flash-color', color);
  flashLayer.style.setProperty('--flash-dur', duration+'ms');
  flashLayer.classList.remove('pulse');
  void flashLayer.offsetWidth;
  flashLayer.classList.add('pulse');
}

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
    const el = pool[Math.floor(Math.random()*pool.length)];
    if(!el) continue;
    el.classList.remove('idle-shimmer');
    void el.offsetWidth;
    el.classList.add('idle-shimmer');
    setTimeout(()=>el.classList.remove('idle-shimmer'), 1150);
  }
}
function hintSparkle(elA, elB){
  [elA, elB].forEach(el=>{ if(el) el.classList.add('hint'); });
  return ()=>{ [elA, elB].forEach(el=>{ if(el) el.classList.remove('hint'); }); };
}

export {
  init, resizeCanvas, burst, ring, beam, shake, flash,
  comboPopup, confettiBurst, idleShimmer, hintSparkle,
};
