/* ============================= SCREENS: navigation + chrome ============================= */
// Splash -> Loading -> Mode Select -> Chapters -> Level Path -> Game.
// This module owns DOM chrome and navigation; engine.js owns match rules;
// render.js/effects.js/audio.js own the pixels and sound.

import * as state from './state.js';
import * as audio from './audio.js';
import * as effects from './effects.js';
import * as render from './render.js';
import * as engine from './engine.js';
import * as api from './api.js';
import { SYMBOLS, MODES, modeById, CHAPTER_SIZE, getLevel, getChapter, getDaily } from './content.js';

const $ = (id)=>document.getElementById(id);
const rand = (n)=>Math.floor(Math.random()*n);

const screens = {
  splash:   $('screen-splash'),
  loading:  $('screen-loading'),
  modes:    $('screen-modes'),
  chapters: $('screen-chapters'),
  path:     $('screen-path'),
  game:     $('screen-game'),
};

function showScreen(name){
  Object.values(screens).forEach(s=>s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
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
  "“Be still, and know…” — even a hard board turns, given patience.",
  "Refiner's Fire levels: match beside a veil to set it free.",
];

let nav = { mode:null, chapter:1 };
let currentLevel = null;
let levelStartedAt = 0;
let idleTimer = null;
let lastInteraction = 0;
let hintClear = null;
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

/* ============================= MODE SELECT ============================= */

function renderModes(){
  const list = $('mode-list');
  list.innerHTML = '';
  MODES.forEach(mode=>{
    const card = document.createElement('button');
    card.className = 'mode-card';
    card.style.setProperty('--mode-color', 'color-mix(in srgb, ' + mode.color + ' 30%, var(--bg-0))');
    const badge = mode.daily ? 'Today’s challenge' : `${state.getUnlockedCount(mode.id)} level${state.getUnlockedCount(mode.id)===1?'':'s'} unlocked`;
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
    showToast('Preparing today’s blessing…', 900);
    const level = await getDaily();
    runLevel(level);
    return;
  }
  nav.chapter = 1;
  showScreen('chapters');
  renderChapters();
}

/* ============================= CHAPTERS ============================= */

function chapterStars(modeId, chapterNum){
  const start = (chapterNum-1)*CHAPTER_SIZE;
  let stars = 0;
  for(let i=0;i<CHAPTER_SIZE;i++) stars += state.getStars(modeId, start+i);
  return stars;
}

function renderChapters(){
  const mode = modeById(nav.mode);
  $('chapters-title').textContent = mode.name;
  $('chapters-sub').textContent = mode.blurb;
  const unlocked = state.getUnlockedCount(mode.id);
  const unlockedChapters = Math.ceil(unlocked / CHAPTER_SIZE);
  const totalToShow = Math.max(3, unlockedChapters + 2);

  const grid = $('chapter-grid');
  grid.innerHTML = '';
  for(let ch=1; ch<=totalToShow; ch++){
    const start = (ch-1)*CHAPTER_SIZE;
    const locked = start >= unlocked;
    const stars = chapterStars(mode.id, ch);
    const card = document.createElement('button');
    card.className = 'chapter-card' + (locked?' locked':'');
    card.innerHTML = `
      <div class="ch-num">${locked?'🔒':'Chapter '+ch}</div>
      <div class="ch-range">Levels ${start+1}–${start+CHAPTER_SIZE}</div>
      <div class="ch-stars">${locked?'':'★ '+stars+' / '+(CHAPTER_SIZE*3)}</div>
    `;
    if(!locked) card.addEventListener('click', ()=>openChapter(ch));
    grid.appendChild(card);
  }
}
function openChapter(ch){
  nav.chapter = ch;
  showScreen('path');
  renderPath();
}

/* ============================= LEVEL PATH ============================= */

function diffColor(rating){
  if(rating==null) return '#4a3f6e';
  if(rating < 0.35) return '#3fa377';
  if(rating < 0.65) return '#e6b754';
  return '#d8455f';
}

async function renderPath(){
  const mode = modeById(nav.mode);
  $('path-title').textContent = `Chapter ${nav.chapter}`;
  $('path-sub').textContent = mode.name;
  const grid = $('lvl-grid');
  grid.innerHTML = '<div style="color:#9c8fc3;font-size:13px;padding:20px;">Loading levels…</div>';

  const levels = await getChapter(mode.id, nav.chapter);
  const unlocked = state.getUnlockedCount(mode.id);

  grid.innerHTML = '';
  levels.forEach(level=>{
    const idx = level.index;
    const locked = idx >= unlocked;
    const stars = state.getStars(mode.id, idx);
    const isCurrent = !locked && idx === Math.min(unlocked-1, levels[levels.length-1].index);
    const card = document.createElement('button');
    card.className = 'lvl-card' + (locked?' locked':'') + (isCurrent?' current':'');
    card.style.setProperty('--diff-color', diffColor(level.difficultyRating));
    card.innerHTML = `
      <div class="diff-dot"></div>
      <div class="num">${locked?'🔒':idx+1}</div>
      <div class="stars">${locked?'':'★'.repeat(stars)+'☆'.repeat(3-stars)}</div>
    `;
    if(!locked) card.addEventListener('click', ()=>runLevel(level));
    grid.appendChild(card);
  });
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
  $('game-level-name').textContent = level.mode==='daily-blessing' ? `Daily Blessing · ${level.date||''}` : `LEVEL ${level.index+1} · ${level.name}`;
  $('game-mode-name').textContent = mode.name;
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
}

function updateHUD(s){
  $('stat-score').textContent = s.score;
  $('stat-moves').textContent = s.movesLeft;

  if(s.objective==='collect'){
    let allDone = true;
    s.collect.forEach(req=>{
      const chip = $('collect-chip-'+req.type);
      if(!chip) return;
      chip.querySelector('span:last-child').textContent = `${req.collected}/${req.count}`;
      const done = req.collected >= req.count;
      chip.classList.toggle('done', done);
      if(!done) allDone = false;
    });
    const fill = $('progress-fill'); const cur = $('progress-current');
    if(fill) fill.style.width = Math.min(100, Math.round((s.score/Math.max(1,s.target))*100)) + '%';
    if(cur) cur.textContent = s.score;
  }else if(s.objective==='veil'){
    const freed = s.veilTotal - s.veilRemaining;
    const pct = s.veilTotal>0 ? Math.round((freed/s.veilTotal)*100) : 100;
    const fill = $('progress-fill'); const cur = $('progress-current');
    if(fill) fill.style.width = pct+'%';
    if(cur) cur.textContent = freed+' freed';
  }else{
    const fill = $('progress-fill'); const cur = $('progress-current');
    const pct = Math.min(100, Math.round((s.score/Math.max(1,s.target))*100));
    if(fill) fill.style.width = pct+'%';
    if(cur) cur.textContent = Math.min(s.score, s.target);
  }
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

/* ============================= GAME: lifecycle ============================= */

async function runLevel(level){
  currentLevel = level;
  showScreen('game');
  renderGameChrome(level);

  const boardEl = $('board');
  effects.init({
    canvas: $('fx-canvas'),
    boardArch: $('board-arch'),
    flashLayer: $('flash-layer'),
    comboPopupEl: $('combo-popup'),
    confettiLayerEl: $('confetti-layer'),
  });

  engine.setCallbacks({
    onHUD: updateHUD,
    onToast: (msg)=>showToast(msg, 1400),
    onWin: onLevelWin,
    onLose: onLevelLose,
  });

  engine.startLevel(level, boardEl);
  effects.resizeCanvas();
  levelStartedAt = Date.now();
  startIdleLoop();
}

function submitResult(level, s, won){
  const movesUsed = level.moves - s.movesLeft;
  api.submitScore({
    mode: level.mode, levelIndex: level.index ?? 0, score: s.score,
    movesUsed, durationMs: Date.now()-levelStartedAt,
  });
  api.sendEvent(won?'level_complete':'level_failed', { mode:level.mode, index:level.index, score:s.score });
}

function onLevelWin(s){
  stopIdleLoop();
  const stars = engine.starsFor(s.score, currentLevel.target || 1);
  if(currentLevel.mode!=='daily-blessing' && currentLevel.index!=null){
    state.recordCompletion(currentLevel.mode, currentLevel.index, stars);
  }
  submitResult(currentLevel, s, true);
  audio.playWinSound();
  audio.vibrate([15,40,15]);
  effects.confettiBurst();

  $('modal-icon').textContent = '🕊️';
  $('modal-title').textContent = 'Level Complete';
  $('modal-message').textContent = WIN_MESSAGES[rand(WIN_MESSAGES.length)];
  $('modal-stars').innerHTML = Array.from({length:3},(_,i)=>`<span class="${i<stars?'lit':''}">${i<stars?'★':'☆'}</span>`).join('');
  $('modal-score-val').textContent = s.score;

  const actions = $('modal-actions');
  actions.innerHTML = '';
  if(currentLevel.mode!=='daily-blessing'){
    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn-primary';
    nextBtn.textContent = 'Next Level →';
    nextBtn.addEventListener('click', async ()=>{ closeModal(); const next = await getLevel(currentLevel.mode, currentLevel.index+1); runLevel(next); });
    actions.appendChild(nextBtn);
  }
  const pathBtn = document.createElement('button');
  pathBtn.className = 'btn-ghost';
  pathBtn.textContent = currentLevel.mode==='daily-blessing' ? 'Back to Modes' : 'Level Select';
  pathBtn.addEventListener('click', ()=>{ closeModal(); currentLevel.mode==='daily-blessing' ? goModes() : renderPath().then(()=>showScreen('path')); });
  actions.appendChild(pathBtn);

  openModal();
}

function onLevelLose(s){
  stopIdleLoop();
  submitResult(currentLevel, s, false);
  audio.playLoseSound();
  audio.vibrate([30,20,30]);

  $('modal-icon').textContent = '🙏';
  $('modal-title').textContent = 'Out of Moves';
  $('modal-message').textContent = LOSE_MESSAGES[rand(LOSE_MESSAGES.length)];
  $('modal-stars').innerHTML = '';
  $('modal-score-val').textContent = `${s.score} / ${s.target}`;

  const actions = $('modal-actions');
  actions.innerHTML = '';
  const retryBtn = document.createElement('button');
  retryBtn.className = 'btn-primary';
  retryBtn.textContent = 'Try Again';
  retryBtn.addEventListener('click', ()=>{ closeModal(); runLevel(currentLevel); });
  actions.appendChild(retryBtn);
  const pathBtn = document.createElement('button');
  pathBtn.className = 'btn-ghost';
  pathBtn.textContent = currentLevel.mode==='daily-blessing' ? 'Back to Modes' : 'Level Select';
  pathBtn.addEventListener('click', ()=>{ closeModal(); currentLevel.mode==='daily-blessing' ? goModes() : renderPath().then(()=>showScreen('path')); });
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
  $('btn-back-chapters').addEventListener('click', ()=>{ stopIdleLoop(); goModes(); });
  $('btn-back-path').addEventListener('click', ()=>{ stopIdleLoop(); showScreen('chapters'); renderChapters(); });
  $('btn-back-game').addEventListener('click', ()=>{ stopIdleLoop(); nav.mode==='daily-blessing'||currentLevel?.mode==='daily-blessing' ? goModes() : (renderPath(), showScreen('path')); });
  engine.setPointerHandler(onBoardPointerDown);
  window.addEventListener('resize', ()=>{ engine.resizeBoard(); effects.resizeCanvas(); });
  window.addEventListener('orientationchange', ()=>{ engine.resizeBoard(); effects.resizeCanvas(); });
}

async function initScreens(){
  await state.loadState();
  audio.setSoundEnabled(state.getSoundOn());
  initSplash();
  initNav();
  showScreen('splash');
}

export { initScreens };
