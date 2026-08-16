/* ============================= SCREENS: navigation + chrome ============================= */
// Splash -> Loading -> Mode Select -> (Dashboard | Chapters -> Level Path) -> Game.
// This module owns DOM chrome and navigation; engine.js owns match rules;
// render.js/effects.js/audio.js own the pixels and sound; lives.js/rewards.js
// own the meta-progression economy.

import * as state from './state.js';
import * as audio from './audio.js';
import * as effects from './effects.js';
import * as render from './render.js';
import * as engine from './engine.js';
import * as api from './api.js';
import * as lives from './lives.js';
import * as rewards from './rewards.js';
import * as theme from './theme.js';
import { SYMBOLS, MODES, modeById, CHAPTER_SIZE, getLevel, getChapter, getDaily } from './content.js';

const $ = (id)=>document.getElementById(id);
const rand = (n)=>Math.floor(Math.random()*n);

const screens = {
  splash:    $('screen-splash'),
  loading:   $('screen-loading'),
  modes:     $('screen-modes'),
  dashboard: $('screen-dashboard'),
  map:       $('screen-map'),
  game:      $('screen-game'),
};

function showScreen(name){
  Object.values(screens).forEach(s=>s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
  audio.playScreenIn();
}
function showToast(msg, ms){
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._h);
  showToast._h = setTimeout(()=>t.classList.add('hidden'), ms||1600);
}

const WIN_MESSAGES = [
  "Well done, good and faithful one.",
  "Your faith has made this level whole.",
  "Every good gift comes from above — and so was that run.",
  "Steady hands, a steadier heart. Level cleared!",
  "You pressed on, and grace met you here.",
  "Light shines brightest after the climb. Beautifully played.",
];
const LOSE_MESSAGES = [
  "Not this time — but joy comes in the morning.",
  "Every attempt is still a step of faith. Try again.",
  "Rest a moment, then rise and try once more.",
  "The race isn't always won on the first lap. Once more!",
  "Even the strongest walls fell after seven tries.",
];
const LOADING_TIPS = [
  "Match 4 in a line for a Striped blessing.",
  "An L or T shape wraps a tile in glory — a Wrapped blast.",
  "Five in a row calls down a Color Bomb.",
  "Pair two specials together for the biggest chaos on the board.",
  "Fill the Combo Surge meter, then tap it for a random burst.",
  "“Be still, and know…” — even a hard board turns, given patience.",
  "Refiner's Fire levels: match beside a veil to set it free.",
  "A chapter's last three levels are always a little different.",
];

let nav = { mode:null };
let currentLevel = null;
let levelStartedAt = 0;
let idleTimer = null;
let lastInteraction = 0;
let hintClear = null;
let hammerArmed = false;
let timerInterval = null;
let timeRemaining = 0;
const IDLE_MS = 6000;

/* ============================= SPLASH / LOADING ============================= */

function initSplash(){
  refreshSoundButtons();
  $('btn-play').addEventListener('click', ()=>{ audio.ensureAudio(); goLoading(); });
  $('btn-sound-splash').addEventListener('click', toggleSound);
}

function goLoading(){
  showScreen('loading');
  const fill = $('loading-fill');
  const tipEl = $('loading-tip');
  fill.style.width = '0%';
  let tipIdx = rand(LOADING_TIPS.length);
  tipEl.textContent = LOADING_TIPS[tipIdx];
  let pct = 0;
  const tipTimer = setInterval(()=>{
    tipIdx = (tipIdx+1) % LOADING_TIPS.length;
    tipEl.style.animation = 'none'; void tipEl.offsetWidth; tipEl.style.animation = '';
    tipEl.textContent = LOADING_TIPS[tipIdx];
  }, 650);
  const progressTimer = setInterval(()=>{
    pct = Math.min(100, pct + 8 + rand(10));
    fill.style.width = pct+'%';
    if(pct>=100){
      clearInterval(progressTimer);
      clearInterval(tipTimer);
      setTimeout(goModes, 200);
    }
  }, 140);
}

/* ============================= STATUS BAR / DASHBOARD ============================= */

function updateStatusBar(){
  const l = $('status-lives'), g = $('status-gems'), s = $('status-streak');
  if(l) l.textContent = lives.getLives();
  if(g) g.textContent = rewards.getGems();
  if(s) s.textContent = rewards.getDailyStatus().streak;
}

function renderDashboard(){
  updateStatusBar();
  const ms = lives.msUntilNextLife();
  const grid = $('dash-grid');
  grid.innerHTML = `
    <div class="dash-tile"><div class="dv">❤️ ${lives.getLives()}/${lives.getCap()}</div><div class="dl">Lives</div>
      <div class="dsub">${ms>0 ? 'Next in '+lives.formatCountdown(ms) : 'Full'}</div></div>
    <div class="dash-tile"><div class="dv">💎 ${rewards.getGems()}</div><div class="dl">Gems</div></div>
    <div class="dash-tile"><div class="dv">🔥 ${rewards.getDailyStatus().streak}</div><div class="dl">Daily Streak</div></div>
    <div class="dash-tile"><div class="dv">${rewards.isDailySessionDone() ? 'Done' : 'Open'}</div><div class="dl">Today's Blessing</div></div>
  `;
  const inv = $('dash-inventory');
  const items = rewards.getInventory();
  const owned = Object.entries(items).filter(([,n])=>n>0);
  inv.innerHTML = owned.length ? owned.map(([id,n])=>{
    const meta = rewards.ITEMS[id];
    return `<div class="dash-item">${meta.emoji} ${meta.name} <strong>×${n}</strong></div>`;
  }).join('') : '<div class="dash-empty">Nothing yet — earn items by finishing chapters and daily sessions.</div>';

  const starsEl = $('dash-stars');
  starsEl.innerHTML = MODES.filter(m=>!m.daily).map(m=>
    `<div class="dash-item">${m.icon} ${m.name} <strong>★${state.getTotalStars(m.id)}</strong></div>`
  ).join('');
}

/* ============================= MODE SELECT ============================= */

function renderModes(){
  theme.resetTheme();
  updateStatusBar();
  const list = $('mode-list');
  list.innerHTML = '';
  MODES.forEach(mode=>{
    const card = document.createElement('button');
    let badge;
    if(mode.daily){
      const status = rewards.getDailyStatus();
      badge = status.session.completed ? `Come back tomorrow · 🔥${status.streak}` : `Today's challenge · 🔥${status.streak} streak`;
    }else{
      badge = `${state.getUnlockedCount(mode.id)} level${state.getUnlockedCount(mode.id)===1?'':'s'} unlocked`;
    }
    card.className = 'mode-card' + (mode.daily && rewards.isDailySessionDone() ? ' done-today' : '');
    card.style.setProperty('--mode-color', 'color-mix(in srgb, ' + mode.color + ' 30%, var(--bg-0))');
    card.innerHTML = `
      <div class="mode-icon">${mode.icon}</div>
      <div class="mode-body">
        <div class="mode-name">${mode.name}</div>
        <div class="mode-blurb">${mode.blurb}</div>
        <span class="mode-badge">${badge}</span>
      </div>
    `;
    card.addEventListener('click', ()=>openMode(mode));
    list.appendChild(card);
  });
}
function goModes(){ renderModes(); showScreen('modes'); }

async function openMode(mode){
  nav.mode = mode.id;
  if(mode.daily){
    if(rewards.isDailySessionDone()){
      const s = rewards.getDailyStatus();
      showToast(`Come back tomorrow — 🔥 ${s.streak} day streak so far!`, 2200);
      return;
    }
    if(!lives.getLives()){ showOutOfLives(); return; }
    showToast('Preparing today’s blessing…', 900);
    const daily = await getDaily();
    const slot = rewards.getDailySessionLevelIndex();
    runLevel(daily.levels[Math.min(slot, daily.levels.length-1)]);
    return;
  }
  showScreen('map');
  renderWorldMap(mode);
}

/* ============================= WORLD MAP ============================= */
// One continuous, page-scrolling trail through every chapter of a mode —
// chapter "regions" are visually distinct banners (own accent color + a
// motif icon), levels are nodes threaded along a smooth winding path
// (an SVG curve drawn through their computed positions), replacing the
// old two-step chapter-grid -> level-grid navigation.

const MAP_NODE_GAP = 104;     // vertical px between consecutive level nodes
const MAP_BANNER_H = 92;      // px reserved for each chapter's banner
const MAP_CHAPTER_PAD = 26;   // px of breathing room after a chapter's last node
const MAP_WAVE_AMP = 30;      // how far a node swings left/right, in % of track width
const MAP_WAVE_STEP = (2*Math.PI)/6; // one full left-right-left cycle every 6 nodes

function chapterStars(modeId, chapterNum){
  const start = (chapterNum-1)*CHAPTER_SIZE;
  let stars = 0;
  for(let i=0;i<CHAPTER_SIZE;i++) stars += state.getStars(modeId, start+i);
  return stars;
}

function diffColor(rating){
  if(rating==null) return '#4a3f6e';
  if(rating < 0.35) return '#3fa377';
  if(rating < 0.65) return '#e6b754';
  return '#d8455f';
}

// Builds the node/banner layout for one continuous map spanning every
// chapter passed in. Coordinates: x in track-width percent (0-100), y in
// px — the SVG trail below is drawn in the same units so it lines up with
// the DOM nodes exactly.
function buildMapLayout(chaptersData){
  let y = 34;
  let globalIdx = 0;
  const nodes = [], banners = [];
  chaptersData.forEach(({ chapterNum, levels, gate })=>{
    banners.push({ chapterNum, y });
    y += MAP_BANNER_H;
    levels.forEach((level, slotIdx)=>{
      const x = 50 + MAP_WAVE_AMP*Math.sin(globalIdx*MAP_WAVE_STEP);
      nodes.push({ level, chapterNum, slotIdx, gate, x, y });
      y += MAP_NODE_GAP;
      globalIdx++;
    });
    y += MAP_CHAPTER_PAD;
  });
  return { nodes, banners, totalHeight: y + 40 };
}

// Smooth curve through every node center, via the standard "quadratic
// through-point" trick: each segment ends at the midpoint between two
// nodes with the node itself as the control point, so the path bends
// naturally at every stop instead of kinking in straight lines.
function buildMapPathD(points){
  if(points.length < 2) return '';
  let d = `M${points[0].x},${points[0].y}`;
  for(let i=0;i<points.length-1;i++){
    const p0=points[i], p1=points[i+1];
    d += ` Q${p0.x},${p0.y} ${(p0.x+p1.x)/2},${(p0.y+p1.y)/2}`;
  }
  const last = points[points.length-1];
  d += ` L${last.x},${last.y}`;
  return d;
}

async function renderWorldMap(mode){
  theme.resetTheme();
  $('map-title').textContent = mode.name;
  $('map-sub').textContent = mode.blurb;
  const track = $('map-track');
  track.style.height = '';
  track.innerHTML = '<div class="map-loading">Charting the path…</div>';

  const unlocked = state.getUnlockedCount(mode.id);
  const unlockedChapters = Math.ceil(unlocked / CHAPTER_SIZE);
  const ceilingChapters = Math.ceil(1000/CHAPTER_SIZE); // this build's documented content range
  const totalToShow = Math.min(ceilingChapters, Math.max(3, unlockedChapters + 2));

  const chapterNums = Array.from({ length: totalToShow }, (_, i)=>i+1);
  const chaptersData = await Promise.all(chapterNums.map(async ch=>{
    const { levels, gate } = await getChapter(mode.id, ch);
    return { chapterNum: ch, levels, gate };
  }));
  if(nav.mode !== mode.id) return; // player navigated away while this was loading

  const { nodes, banners, totalHeight } = buildMapLayout(chaptersData);
  track.style.height = totalHeight + 'px';
  track.innerHTML = `<svg class="map-path-svg" viewBox="0 0 100 ${totalHeight}" preserveAspectRatio="none">
    <path d="${buildMapPathD(nodes.map(n=>({x:n.x,y:n.y})))}" fill="none" stroke="rgba(230,183,84,.32)" stroke-width="2.4" stroke-dasharray="1.4 8" stroke-linecap="round"/>
  </svg>`;

  banners.forEach(b=>{
    const el = document.createElement('div');
    el.className = 'map-chapter-banner';
    el.style.top = b.y + 'px';
    el.style.setProperty('--band-color', theme.chapterColor(b.chapterNum));
    el.innerHTML = `<span class="band-icon">${SYMBOLS[(b.chapterNum-1)%SYMBOLS.length].emoji}</span><span class="band-text">Chapter ${b.chapterNum}</span>`;
    track.appendChild(el);
  });

  let currentNodeEl = null;
  nodes.forEach(n=>{
    const { level, chapterNum, slotIdx, gate } = n;
    const idx = level.index;
    const starsSoFar = chapterStars(mode.id, chapterNum);
    const gateBlocked = gate && slotIdx >= gate.position && starsSoFar < gate.starsRequired;
    const locked = idx >= unlocked || gateBlocked;
    const stars = state.getStars(mode.id, idx);
    const isCurrent = !locked && idx === unlocked-1;

    const btn = document.createElement('button');
    btn.className = 'map-node'
      + (locked?' locked':'') + (isCurrent?' current':'')
      + (gateBlocked?' gated':'') + (level.finale?' finale':'');
    btn.style.left = n.x + '%';
    btn.style.top = n.y + 'px';
    btn.style.setProperty('--chapter-accent', theme.chapterColor(chapterNum));
    btn.style.setProperty('--diff-color', diffColor(level.difficultyRating));
    if(gateBlocked){
      btn.innerHTML = `<div class="mn-icon">🔒</div><div class="mn-gate">★${gate.starsRequired}</div>`;
      btn.addEventListener('click', ()=>{ audio.playGateSting(); showToast(`Earn ★${gate.starsRequired} in this chapter to open it.`, 1800); });
    }else{
      btn.innerHTML = `
        <div class="diff-dot"></div>
        <div class="mn-icon">${locked?'🔒':(level.finale?'✦':idx+1)}</div>
        ${locked?'':`<div class="mn-stars">${'★'.repeat(stars)}${'☆'.repeat(3-stars)}</div>`}
      `;
      if(!locked) btn.addEventListener('click', ()=>runLevel(level));
    }
    track.appendChild(btn);
    if(isCurrent) currentNodeEl = btn;
  });

  requestAnimationFrame(()=>{
    (currentNodeEl || track.lastElementChild)?.scrollIntoView({ block:'center', behavior:'smooth' });
  });
}

// Shared "leave the game screen for the current mode's map" path — used by
// the win/lose modals' Level Select button and the in-game back arrow.
function backToMap(modeId){
  const mode = modeById(modeId);
  if(!mode) return goModes();
  nav.mode = modeId;
  showScreen('map');
  renderWorldMap(mode);
}

/* ============================= GAME: chrome + HUD ============================= */

function objectiveAreaHTML(level){
  if(level.objective==='collect'){
    return `<div class="collect-row" id="collect-row"></div>
      <div class="progress-wrap"><div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
      <div class="progress-label"><span id="progress-current">0</span><span>Bonus score</span></div></div>`;
  }
  if(level.objective==='veil'){
    return `<div class="progress-wrap"><div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
      <div class="progress-label"><span id="progress-current">0 freed</span><span id="progress-target">of ${level.veil?.cells?.length||0}</span></div></div>`;
  }
  return `<div class="progress-wrap"><div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
    <div class="progress-label"><span id="progress-current">0</span><span id="progress-target">Target ${level.target}</span></div></div>`;
}

function renderGameChrome(level){
  const mode = modeById(level.mode) || { name:'Faith Match' };
  $('game-level-name').textContent = level.mode==='daily-blessing'
    ? `Daily Blessing · ${(level.dailySlot??0)+1}/3` : `LEVEL ${level.index+1} · ${level.name}`;
  $('game-mode-name').textContent = level.finale ? `${mode.name} · Stage Finale` : mode.name;
  $('objective-area').innerHTML = objectiveAreaHTML(level);
  if(level.objective==='collect'){
    const row = $('collect-row');
    level.collect.forEach(req=>{
      const chip = document.createElement('div');
      chip.className = 'collect-chip';
      chip.id = 'collect-chip-'+req.type;
      chip.innerHTML = `<span class="cc-emoji">${SYMBOLS[req.type].emoji}</span><span>0/${req.count}</span>`;
      row.appendChild(chip);
    });
  }
  const timerBadge = $('timer-badge');
  if(level.timedSeconds){
    timerBadge.classList.remove('hidden');
    timerBadge.textContent = formatTime(level.timedSeconds);
  }else{
    timerBadge.classList.add('hidden');
  }
}

function formatTime(sec){
  const m = Math.floor(sec/60), s = sec%60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function updateHUD(s){
  $('stat-score').textContent = s.score;
  $('stat-moves').textContent = s.movesLeft;

  const meterWrap = $('btn-combo-meter'), meterFill = $('meter-fill'), meterLabel = $('meter-label');
  const pct = Math.round((s.comboMeter/s.comboMeterCap)*100);
  meterFill.style.width = pct+'%';
  const ready = s.comboMeter >= s.comboMeterCap;
  meterWrap.classList.toggle('ready', ready);
  meterLabel.textContent = ready ? 'Tap for a surge!' : 'Combo Surge';

  if(s.objective==='collect'){
    s.collect.forEach(req=>{
      const chip = $('collect-chip-'+req.type);
      if(!chip) return;
      chip.querySelector('span:last-child').textContent = `${req.collected}/${req.count}`;
      chip.classList.toggle('done', req.collected >= req.count);
    });
    const fill = $('progress-fill'); const cur = $('progress-current');
    if(fill) fill.style.width = Math.min(100, Math.round((s.score/Math.max(1,s.target))*100)) + '%';
    if(cur) cur.textContent = s.score;
  }else if(s.objective==='veil'){
    const freed = s.veilTotal - s.veilRemaining;
    const pct2 = s.veilTotal>0 ? Math.round((freed/s.veilTotal)*100) : 100;
    const fill = $('progress-fill'); const cur = $('progress-current');
    if(fill) fill.style.width = pct2+'%';
    if(cur) cur.textContent = freed+' freed';
  }else{
    const fill = $('progress-fill'); const cur = $('progress-current');
    const pct3 = Math.min(100, Math.round((s.score/Math.max(1,s.target))*100));
    if(fill) fill.style.width = pct3+'%';
    if(cur) cur.textContent = Math.min(s.score, s.target);
  }
}

/* ============================= GAME: timed countdown ============================= */

function stopTimer(){ if(timerInterval){ clearInterval(timerInterval); timerInterval=null; } }
function startTimer(level){
  stopTimer();
  if(!level.timedSeconds) return;
  timeRemaining = level.timedSeconds;
  timerInterval = setInterval(()=>{
    if(engine.isBusy()){ /* don't tick mid-resolve, keeps it fair */ return; }
    timeRemaining--;
    const badge = $('timer-badge');
    badge.textContent = formatTime(Math.max(0,timeRemaining));
    badge.classList.toggle('low', timeRemaining<=30);
    if(timeRemaining<=0){
      stopTimer();
      effects.flash('#ff6b6b', 500);
      effects.shake(18, 400);
      audio.playLoseSound();
      onLevelLose(engine.getSessionState(), true);
    }
  }, 1000);
}
function extendTimer(seconds){
  if(timerInterval) timeRemaining += seconds;
}

/* ============================= GAME: input ============================= */

let selectedCell = null;
let pointerStart = null;

function cellFromPoint(x,y){
  const boardEl = render.getBoardEl();
  const rect = boardEl.getBoundingClientRect();
  const ts = render.getTileSize();
  const c = Math.floor((x-rect.left)/ts);
  const r = Math.floor((y-rect.top)/ts);
  if(r<0||r>=currentLevel.rows||c<0||c>=currentLevel.cols) return null;
  return {r,c};
}
function clearSelection(){
  if(selectedCell){
    const el = engine.getTileElAt(selectedCell.r, selectedCell.c);
    if(el) el.classList.remove('selected');
  }
  selectedCell = null;
}
function setSelection(cell){
  clearSelection();
  const el = engine.getTileElAt(cell.r, cell.c);
  if(el) el.classList.add('selected');
  selectedCell = cell;
}

function registerInteraction(){ lastInteraction = Date.now(); clearHint(); }

function onBoardPointerDown(e){
  if(engine.isBusy()) return;
  audio.ensureAudio();
  registerInteraction();
  const cell = cellFromPoint(e.clientX, e.clientY);
  if(!cell) return;

  if(hammerArmed){
    hammerArmed = false;
    document.body.classList.remove('hammer-mode');
    engine.useHammer(cell.r, cell.c);
    return;
  }

  pointerStart = { x:e.clientX, y:e.clientY, cell };
  window.addEventListener('pointerup', onBoardPointerUp, { once:true });
}
function onBoardPointerUp(e){
  if(!pointerStart) return;
  const dx = e.clientX - pointerStart.x, dy = e.clientY - pointerStart.y;
  const dist = Math.hypot(dx,dy);
  const startCell = pointerStart.cell;
  const ts = render.getTileSize();
  pointerStart = null;

  if(dist > ts*0.28){
    let target;
    if(Math.abs(dx) > Math.abs(dy)) target = { r:startCell.r, c:startCell.c + (dx>0?1:-1) };
    else target = { r:startCell.r + (dy>0?1:-1), c:startCell.c };
    if(target.r>=0 && target.r<currentLevel.rows && target.c>=0 && target.c<currentLevel.cols){
      clearSelection();
      engine.attemptSwap(startCell, target);
      return;
    }
  }
  if(!selectedCell){ setSelection(startCell); return; }
  if(selectedCell.r===startCell.r && selectedCell.c===startCell.c){ clearSelection(); return; }
  if(engine.isAdjacent(selectedCell, startCell)){
    const from = selectedCell;
    clearSelection();
    engine.attemptSwap(from, startCell);
  }else{
    setSelection(startCell);
  }
}

/* ============================= GAME: idle life ============================= */

function clearHint(){ if(hintClear){ hintClear(); hintClear=null; } }
function startIdleLoop(){
  stopIdleLoop();
  lastInteraction = Date.now();
  idleTimer = setInterval(()=>{
    if(engine.isBusy()) return;
    if(Date.now()-lastInteraction < IDLE_MS) return;
    const { tileEls, hintEls } = engine.getIdleVisualTargets();
    effects.idleShimmer(tileEls);
    if(hintEls && hintEls[0] && hintEls[1] && !hintClear){
      hintClear = effects.hintSparkle(hintEls[0], hintEls[1]);
      setTimeout(clearHint, 1700);
    }
  }, 2200);
}
function stopIdleLoop(){ if(idleTimer){ clearInterval(idleTimer); idleTimer=null; } clearHint(); }

/* ============================= GAME: inventory tray ============================= */

function renderTray(){
  const list = $('tray-list');
  const items = rewards.getInventory();
  const owned = Object.entries(items).filter(([,n])=>n>0);
  if(!owned.length){
    list.innerHTML = '<div class="dash-empty">No items yet — earn them by finishing chapters and daily sessions.</div>';
    return;
  }
  list.innerHTML = '';
  owned.forEach(([id,count])=>{
    const meta = rewards.ITEMS[id];
    const btn = document.createElement('button');
    btn.className = 'tray-item';
    btn.innerHTML = `<span class="ti-emoji">${meta.emoji}</span>
      <span class="ti-body"><div class="ti-name">${meta.name}</div><div class="ti-desc">${meta.desc}</div></span>
      <span class="ti-count">×${count}</span>`;
    btn.addEventListener('click', ()=>useInventoryItem(id));
    list.appendChild(btn);
  });
}
function openTray(){ renderTray(); $('tray-overlay').classList.remove('hidden'); }
function closeTray(){ $('tray-overlay').classList.add('hidden'); }

function useInventoryItem(id){
  if(engine.isBusy()) return;
  if(id==='hammer'){
    if(!rewards.useItem('hammer')) return;
    closeTray();
    hammerArmed = true;
    document.body.classList.add('hammer-mode');
    showToast('Tap any tile to smash it.', 1800);
    return;
  }
  if(id==='freeze'){
    if(!currentLevel.timedSeconds || !timerInterval){ showToast('Freeze only works on a timed level.', 1600); return; }
    if(!rewards.useItem('freeze')) return;
    extendTimer(60);
    showToast('Freeze! +60 seconds.', 1400);
    closeTray();
    return;
  }
  if(id==='extraMoves'){
    if(!rewards.useItem('extraMoves')) return;
    engine.addMoves(3);
    showToast('+3 moves!', 1200);
    closeTray();
    return;
  }
  if(id==='rainbowShuffle'){
    if(!rewards.useItem('rainbowShuffle')) return;
    engine.useRainbowShuffle();
    closeTray();
    return;
  }
  if(id==='colorBombGift'){
    if(!rewards.useItem('colorBombGift')) return;
    engine.useColorBombGift();
    closeTray();
    return;
  }
}

/* ============================= GAME: lives + continue ============================= */

function showOutOfLives(){
  const ms = lives.msUntilNextLife();
  $('modal-icon').textContent = '💤';
  $('modal-title').textContent = 'Out of Lives';
  $('modal-message').textContent = `Rest a moment — your next life is ready in ${lives.formatCountdown(ms)}.`;
  $('modal-stars').innerHTML = '';
  $('modal-score-val').textContent = `❤️ 0 / ${lives.getCap()}`;

  const actions = $('modal-actions');
  actions.innerHTML = '';
  const refillBtn = document.createElement('button');
  refillBtn.className = 'btn-primary';
  refillBtn.textContent = `Refill for 💎${rewards.LIFE_REFILL_COST}`;
  refillBtn.disabled = rewards.getGems() < rewards.LIFE_REFILL_COST;
  refillBtn.addEventListener('click', ()=>{
    if(rewards.spendGems(rewards.LIFE_REFILL_COST)){ lives.addLives(1); closeModal(); updateStatusBar(); }
  });
  actions.appendChild(refillBtn);
  const backBtn = document.createElement('button');
  backBtn.className = 'btn-ghost';
  backBtn.textContent = 'Wait it out';
  backBtn.addEventListener('click', closeModal);
  actions.appendChild(backBtn);

  openModal();
}

function offerContinue(s){
  const affordable = rewards.getGems() >= rewards.CONTINUE_COST;
  $('modal-icon').textContent = '⏳';
  $('modal-title').textContent = 'Out of Moves';
  $('modal-message').textContent = affordable
    ? `Spend 💎${rewards.CONTINUE_COST} for ${rewards.CONTINUE_MOVES} more moves?`
    : 'Out of moves — and gems. So close!';
  $('modal-stars').innerHTML = '';
  $('modal-score-val').textContent = `${s.score} / ${s.target}`;

  const actions = $('modal-actions');
  actions.innerHTML = '';
  if(affordable){
    const continueBtn = document.createElement('button');
    continueBtn.className = 'btn-primary';
    continueBtn.textContent = `Continue · 💎${rewards.CONTINUE_COST}`;
    continueBtn.addEventListener('click', ()=>{
      rewards.spendGems(rewards.CONTINUE_COST);
      engine.addMoves(rewards.CONTINUE_MOVES);
      updateStatusBar();
      closeModal();
    });
    actions.appendChild(continueBtn);
  }
  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn-ghost';
  stopBtn.textContent = 'End Run';
  stopBtn.addEventListener('click', ()=>{ closeModal(); engine.forceLose(); });
  actions.appendChild(stopBtn);

  openModal();
}

/* ============================= GAME: lifecycle ============================= */

async function runLevel(level){
  if(!lives.getLives()){ showOutOfLives(); return; }

  currentLevel = level;
  showScreen('game');
  renderGameChrome(level);
  // The world map shows every chapter's own accent color inline per-node;
  // gameplay itself still needs the single global --chapter-accent (board
  // frame glow, etc.) set to whichever chapter this level belongs to.
  if(level.mode!=='daily-blessing' && level.index!=null) theme.applyChapterTheme(Math.floor(level.index/CHAPTER_SIZE)+1);
  else theme.resetTheme();
  if(level.finale && level.skin) theme.applyFinaleSkin(level.skin);

  const boardEl = $('board');
  engine.setCallbacks({
    onHUD: updateHUD,
    onToast: (msg)=>showToast(msg, 1400),
    onWin: onLevelWin,
    onLose: onLevelLose,
    onOutOfMoves: offerContinue,
  });

  // Awaited: WebGL init + procedural tile textures are async on first use
  // (see js/render.js getReady()) — effects.js needs the Pixi stage to
  // already exist before it adds its own particle/flash layers to it.
  await engine.startLevel(level, boardEl);

  effects.init({
    boardArch: $('board-arch'),
    comboPopupEl: $('combo-popup'),
    confettiLayerEl: $('confetti-layer'),
  });

  levelStartedAt = Date.now();
  startIdleLoop();
  startTimer(level);
  audio.startAmbientPad();
  if(level.finale) audio.playFinaleSting();
}

function submitResult(level, s, won){
  const movesUsed = level.moves - s.movesLeft;
  api.submitScore({
    mode: level.mode, levelIndex: level.index ?? 0, score: s.score,
    movesUsed, durationMs: Date.now()-levelStartedAt,
  });
  api.sendEvent(won?'level_complete':'level_failed', { mode:level.mode, index:level.index, score:s.score });
}

function isChapterComplete(level, stars){
  if(level.mode==='daily-blessing') return false;
  const slot = level.index % CHAPTER_SIZE;
  return slot === CHAPTER_SIZE-1 && stars>0;
}

function onLevelWin(s){
  stopIdleLoop(); stopTimer(); audio.stopAmbientPad();
  const stars = engine.starsFor(s.score, currentLevel.target || 1);
  let rewardLines = [];

  if(currentLevel.mode==='daily-blessing'){
    const result = rewards.advanceDailySession(s.score);
    if(result.reward){
      rewardLines.push(`💎${result.reward.gems} + ${rewards.ITEMS[result.reward.item].emoji} ${rewards.ITEMS[result.reward.item].name}`);
      audio.playStreakSting(result.streak);
    }
  }else if(currentLevel.index!=null){
    state.recordCompletion(currentLevel.mode, currentLevel.index, stars);
    const gems = rewards.rewardForLevel(stars);
    if(gems){ rewards.addGems(gems); rewardLines.push(`💎${gems}`); }
    if(isChapterComplete(currentLevel, stars)){
      const chReward = rewards.rewardForChapter();
      rewardLines.push(`Chapter bonus: 💎${chReward.gems} + ${rewards.ITEMS[chReward.item].emoji} ${rewards.ITEMS[chReward.item].name}`);
    }
  }
  updateStatusBar();

  submitResult(currentLevel, s, true);
  audio.playWinSound();
  audio.vibrate([15,40,15]);
  effects.confettiBurst();

  $('modal-icon').textContent = '🕊️';
  $('modal-title').textContent = 'Level Complete';
  $('modal-message').textContent = WIN_MESSAGES[rand(WIN_MESSAGES.length)] + (rewardLines.length ? `  ·  ${rewardLines.join('  ·  ')}` : '');
  $('modal-stars').innerHTML = Array.from({length:3},(_,i)=>`<span class="${i<stars?'lit':''}">${i<stars?'★':'☆'}</span>`).join('');
  $('modal-score-val').textContent = s.score;

  const actions = $('modal-actions');
  actions.innerHTML = '';
  if(currentLevel.mode==='daily-blessing'){
    const done = rewards.isDailySessionDone();
    if(!done){
      const nextBtn = document.createElement('button');
      nextBtn.className = 'btn-primary';
      nextBtn.textContent = 'Next Level →';
      nextBtn.addEventListener('click', async ()=>{
        closeModal();
        const daily = await getDaily();
        const slot = rewards.getDailySessionLevelIndex();
        runLevel(daily.levels[Math.min(slot, daily.levels.length-1)]);
      });
      actions.appendChild(nextBtn);
    }
  }else{
    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn-primary';
    nextBtn.textContent = 'Next Level →';
    nextBtn.addEventListener('click', async ()=>{ closeModal(); const next = await getLevel(currentLevel.mode, currentLevel.index+1); runLevel(next); });
    actions.appendChild(nextBtn);
  }
  const pathBtn = document.createElement('button');
  pathBtn.className = 'btn-ghost';
  pathBtn.textContent = currentLevel.mode==='daily-blessing' ? 'Back to Modes' : 'Level Select';
  pathBtn.addEventListener('click', ()=>{ closeModal(); currentLevel.mode==='daily-blessing' ? goModes() : backToMap(currentLevel.mode); });
  actions.appendChild(pathBtn);

  openModal();
}

function onLevelLose(s, timedOut){
  stopIdleLoop(); stopTimer(); audio.stopAmbientPad();
  lives.loseLife();
  updateStatusBar();
  submitResult(currentLevel, s, false);
  audio.playLoseSound();
  audio.vibrate([30,20,30]);

  $('modal-icon').textContent = timedOut ? '💥' : '🙏';
  $('modal-title').textContent = timedOut ? "Time's Up" : 'Out of Moves';
  $('modal-message').textContent = LOSE_MESSAGES[rand(LOSE_MESSAGES.length)];
  $('modal-stars').innerHTML = '';
  $('modal-score-val').textContent = `${s.score} / ${s.target}`;

  const actions = $('modal-actions');
  actions.innerHTML = '';
  const retryBtn = document.createElement('button');
  retryBtn.className = 'btn-primary';
  retryBtn.textContent = lives.getLives()>0 ? 'Try Again' : `Out of Lives`;
  retryBtn.disabled = lives.getLives()<=0;
  retryBtn.addEventListener('click', ()=>{ closeModal(); runLevel(currentLevel); });
  actions.appendChild(retryBtn);
  const pathBtn = document.createElement('button');
  pathBtn.className = 'btn-ghost';
  pathBtn.textContent = currentLevel.mode==='daily-blessing' ? 'Back to Modes' : 'Level Select';
  pathBtn.addEventListener('click', ()=>{ closeModal(); currentLevel.mode==='daily-blessing' ? goModes() : backToMap(currentLevel.mode); });
  actions.appendChild(pathBtn);

  openModal();
}

function openModal(){ $('modal-overlay').classList.remove('hidden'); }
function closeModal(){ $('modal-overlay').classList.add('hidden'); }

/* ============================= SOUND ============================= */

function refreshSoundButtons(){
  const label = (state.getSoundOn() ? '🔊 Sound On' : '🔈 Sound Off');
  $('btn-sound-splash').textContent = label;
  $('btn-sound-game').textContent = state.getSoundOn() ? '🔊' : '🔈';
}
function toggleSound(){
  state.setSoundOn(!state.getSoundOn());
  audio.setSoundEnabled(state.getSoundOn());
  refreshSoundButtons();
}

/* ============================= INIT ============================= */

function initNav(){
  $('btn-sound-game').addEventListener('click', toggleSound);
  $('btn-dashboard').addEventListener('click', ()=>{ audio.playUiTap(); renderDashboard(); showScreen('dashboard'); });
  $('btn-back-dashboard').addEventListener('click', ()=>{ goModes(); });
  $('btn-back-map').addEventListener('click', ()=>{ stopIdleLoop(); goModes(); });
  $('btn-back-game').addEventListener('click', ()=>{
    stopIdleLoop(); stopTimer(); audio.stopAmbientPad();
    (nav.mode==='daily-blessing' || currentLevel?.mode==='daily-blessing') ? goModes() : backToMap(currentLevel?.mode ?? nav.mode);
  });
  $('btn-inventory').addEventListener('click', ()=>{ audio.playUiTap(); openTray(); });
  $('btn-tray-close').addEventListener('click', ()=>{ audio.playUiTap(); closeTray(); });
  $('btn-combo-meter').addEventListener('click', ()=>{ engine.popComboMeter(); });
  engine.setPointerHandler(onBoardPointerDown);
  window.addEventListener('resize', ()=>{ engine.resizeBoard(); effects.resizeCanvas(); });
  window.addEventListener('orientationchange', ()=>{ engine.resizeBoard(); effects.resizeCanvas(); });
}

async function initScreens(){
  await state.loadState();
  audio.setSoundEnabled(state.getSoundOn());
  theme.resetTheme();
  initSplash();
  initNav();
  showScreen('splash');
}

export { initScreens };
