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
import * as splashFx from './splash-fx.js';
import * as account from './account.js';
import { SYMBOLS, MODES, modeById, CHAPTER_SIZE, CONTENT_CEILING_LEVELS, getLevel, getChapter, getDaily } from './content.js';
import { iconSVG } from './icons.js';

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
  // Every non-game, non-map screen shares the menu theme; the World Map
  // gets its own dedicated track; runLevel() takes over with the
  // per-mode gameplay loop once a level actually starts. This naturally
  // resumes the right theme on any way back out without each nav handler
  // needing to know about audio.
  if(name === 'map') audio.playMapTheme();
  else if(name !== 'game') audio.playMenuTheme();
  if(name === 'dashboard') startDashboardClock(); else stopDashboardClock();
  if(name === 'splash') splashFx.start(); else splashFx.stop();
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
let meterWasReady = false;
let levelStartedAt = 0;
let idleTimer = null;
let lastInteraction = 0;
let hintClear = null;
let hammerArmed = false;
let skyHookArmed = false;
let skyHookFirstCell = null;
let timerInterval = null;
let timeRemaining = 0;
let slowMoUntil = 0; // Date.now() timestamp — see Slow-Mo Sand in startTimer()
let slowMoSkipNext = false;
const IDLE_MS = 6000;
const GEMS_EXPLAINER = '💎 Gems — earned by clearing levels and chapters (and mid-level bonuses like the Halo Bomb). Spend them on life refills and move continues.';

/* ============================= SPLASH / LOADING ============================= */

function renderSplashMotif(){
  const row = $('splash-motif');
  if(!row) return;
  row.innerHTML = SYMBOLS.map((s,i)=>
    `<span class="sm-swatch" style="--sm-color:${s.color}; animation-delay:${(i*0.18).toFixed(2)}s">${iconSVG(i)}</span>`
  ).join('');
}

function initSplash(){
  refreshSoundButtons();
  renderSplashMotif();
  $('btn-play').addEventListener('click', ()=>{ audio.ensureAudio(); goLoading(); });
  $('btn-sound-splash').addEventListener('click', toggleSound);
  splashFx.init($('splash-fx-canvas')).then(()=>{ splashFx.start(); });
  window.addEventListener('resize', splashFx.resize);
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
  const grid = $('dash-grid');
  grid.innerHTML = `
    <div class="dash-tile"><div class="dv" id="dash-lives-val"></div><div class="dl">Lives</div>
      <div class="dsub" id="dash-lives-sub"></div></div>
    <button class="dash-tile" type="button" id="dash-gems-tile"><div class="dv">💎 ${rewards.getGems()}</div><div class="dl">Gems</div></button>
    <div class="dash-tile"><div class="dv">🔥 ${rewards.getDailyStatus().streak}</div><div class="dl">Daily Streak</div></div>
    <div class="dash-tile"><div class="dv">${rewards.isDailySessionDone() ? 'Done' : 'Open'}</div><div class="dl">Today's Blessing</div></div>
  `;
  $('dash-gems-tile').addEventListener('click', ()=>showToast(GEMS_EXPLAINER, 2600));
  tickDashboardLives();
  const inv = $('dash-inventory');
  const items = rewards.getInventory();
  const owned = Object.entries(items).filter(([,n])=>n>0);
  // The chips here only ever showed an emoji, a name, and a count — no
  // room for (and previously no) explanation of what an item actually
  // does, which is exactly why items like Shield/Sky Hook/Slow-Mo Sand
  // read as unlabeled mystery icons. Every chip is now tappable and shows
  // its real description (the same one already used in the in-game hints
  // tray, see renderTray() below) via a toast, instead of duplicating
  // full descriptions inline and cramping the compact chip row.
  inv.innerHTML = owned.length ? owned.map(([id,n])=>{
    const meta = rewards.ITEMS[id];
    if(!meta) return ''; // an id no longer in ITEMS (e.g. an old save) shouldn't take the whole dashboard down
    return `<button class="dash-item" type="button" data-item-id="${id}">${meta.emoji} ${meta.name} <strong>×${n}</strong></button>`;
  }).join('') : '<div class="dash-empty">Nothing yet — earn items by finishing chapters and daily sessions.</div>';
  inv.querySelectorAll('[data-item-id]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const meta = rewards.ITEMS[btn.dataset.itemId];
      if(meta) showToast(`${meta.emoji} ${meta.name} — ${meta.desc}`, 2600);
    });
  });

  const starsEl = $('dash-stars');
  starsEl.innerHTML = MODES.filter(m=>!m.daily).map(m=>
    `<div class="dash-item">${m.icon} ${m.name} <strong>★${state.getTotalStars(m.id)}</strong></div>`
  ).join('');

  refreshAccountRow();
}

// The "Next life in ⏱" line was only ever computed at render time — it sat
// frozen until the player left and came back, reading as "not real time".
// This ticks the two lives-related fields once a second while the
// Dashboard is actually the visible screen (started/stopped from
// showScreen(), same pattern as the audio menu-theme hookup).
function tickDashboardLives(){
  const val = $('dash-lives-val'), sub = $('dash-lives-sub');
  if(!val || !sub) return;
  const ms = lives.msUntilNextLife();
  val.textContent = `❤️ ${lives.getLives()}/${lives.getCap()}`;
  sub.textContent = ms>0 ? 'Next in '+lives.formatCountdown(ms) : 'Full';
}
let dashClockInterval = null;
function startDashboardClock(){
  stopDashboardClock();
  dashClockInterval = setInterval(tickDashboardLives, 1000);
}
function stopDashboardClock(){ if(dashClockInterval){ clearInterval(dashClockInterval); dashClockInterval=null; } }

/* ============================= PLAYER PROFILE (cross-device sync) ============================= */
// See js/account.js for the actual register/login/logout/sync calls —
// this is purely the UI layer: the Dashboard row, the sign-in panel, and
// the "which progress do you want?" conflict prompt. Never silently
// overwrites either side of a real divergence between this device's local
// progress and what's saved to a profile.

function refreshAccountRow(){
  const row = $('btn-open-account'), title = $('dash-account-title'), sub = $('dash-account-sub');
  const chip = $('btn-profile-shortcut');
  const signedIn = account.isLoggedIn();
  if(row){
    if(signedIn){
      title.textContent = `Signed in as ${account.getUsername()}`;
      sub.textContent = 'Tap to manage your profile';
      row.classList.add('signed-in');
    }else{
      title.textContent = 'Guest — progress stays on this device';
      sub.textContent = 'Sign in to carry progress to your phone or a new device';
      row.classList.remove('signed-in');
    }
  }
  // The status-bar shortcut chip (visible on the Modes screen — the very
  // first thing a player sees, not buried inside the Dashboard) mirrors
  // the same signed-in/guest state: a gold dot while signed out, gone once
  // signed in, so it reads as "there's something to do here" until it is.
  if(chip){
    chip.classList.toggle('signed-in', signedIn);
    chip.classList.toggle('guest', !signedIn);
  }
}

// A "fresh" device (nothing played yet) can silently adopt a pulled cloud
// save with no prompt — there's nothing on this side worth asking about
// keeping. Anything beyond the untouched default gets the conflict prompt
// instead of a silent overwrite.
function isFreshLocalState(){
  if(rewards.getGems() > 0) return false;
  if(rewards.getDailyStatus().streak > 0) return false;
  for(const m of MODES){
    if(m.daily) continue;
    if(state.getUnlockedCount(m.id) > 1) return false;
  }
  return true;
}

function reconcileCloudState(cloudState, cloudUpdatedAt){
  if(!cloudState) return;
  const localSnapshot = state.snapshot();
  if(JSON.stringify(cloudState) === JSON.stringify(localSnapshot)) return; // already in sync
  if(isFreshLocalState()){
    state.replaceState(cloudState);
    updateStatusBar();
    showToast('Welcome back! Progress restored from your profile.', 2200);
  }else{
    showAccountConflict(cloudState, cloudUpdatedAt);
  }
}

let pendingConflictState = null;
function showAccountConflict(cloudState, cloudUpdatedAt){
  pendingConflictState = cloudState;
  const when = cloudUpdatedAt ? new Date(cloudUpdatedAt*1000).toLocaleDateString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'another device';
  $('account-conflict-detail').textContent = `Your profile has progress saved from ${when} that's different from what's on this device. Which one do you want to keep?`;
  $('account-conflict-overlay').classList.remove('hidden');
}
function closeAccountConflict(){
  $('account-conflict-overlay').classList.add('hidden');
  pendingConflictState = null;
}

// Called once at startup (after state.loadState()) if an account token is
// already saved on this device — this is the actual mechanic that makes
// "log in on the new phone, get your progress back" work without the
// player doing anything beyond having logged in once before.
async function syncOnLoad(){
  if(!account.isLoggedIn()) return;
  const result = await account.pullState().catch(()=>null);
  if(!result) return; // offline, or the request failed — try again next time a save fires
  reconcileCloudState(result.state, result.updatedAt);
}

function showAccountError(msg){
  const el = $('account-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearAccountError(){ $('account-error').classList.add('hidden'); }

function renderAccountPanelState(){
  const signedOut = $('account-signed-out'), signedIn = $('account-signed-in');
  if(account.isLoggedIn()){
    signedOut.classList.add('hidden');
    signedIn.classList.remove('hidden');
    $('account-username-display').textContent = account.getUsername();
    $('account-sync-status').textContent = 'Progress syncs automatically while signed in.';
  }else{
    signedOut.classList.remove('hidden');
    signedIn.classList.add('hidden');
    $('account-username').value = '';
    $('account-password').value = '';
  }
}
function openAccountPanel(){
  clearAccountError();
  renderAccountPanelState();
  $('account-overlay').classList.remove('hidden');
}
function closeAccountPanel(){ $('account-overlay').classList.add('hidden'); }

async function handleAccountLogin(){
  const user = $('account-username').value.trim();
  const pass = $('account-password').value;
  clearAccountError();
  if(!user || !pass){ showAccountError('Enter a username and password.'); return; }
  try{
    const result = await account.login(user, pass);
    closeAccountPanel();
    refreshAccountRow();
    audio.playRewardChime();
    reconcileCloudState(result.state, result.updatedAt);
  }catch(e){
    showAccountError(e.message || 'Could not log in.');
  }
}
async function handleAccountRegister(){
  const user = $('account-username').value.trim();
  const pass = $('account-password').value;
  clearAccountError();
  if(!user || !pass){ showAccountError('Enter a username and password.'); return; }
  try{
    await account.register(user, pass); // uploads this device's current progress as the starting cloud save
    closeAccountPanel();
    refreshAccountRow();
    showToast('Profile created — your progress will follow you now.', 2200);
  }catch(e){
    showAccountError(e.message || 'Could not create a profile.');
  }
}
function handleAccountLogout(){
  account.logout();
  refreshAccountRow();
  closeAccountPanel();
  showToast('Signed out — progress stays on this device from here.', 1800);
}
async function handleAccountSyncNow(){
  const status = $('account-sync-status');
  status.textContent = 'Syncing…';
  const result = await account.pushState();
  status.textContent = result ? 'Synced just now.' : 'Sync failed — will retry automatically.';
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
    const bannerY = y;
    y += MAP_BANNER_H;
    levels.forEach((level, slotIdx)=>{
      const x = 50 + MAP_WAVE_AMP*Math.sin(globalIdx*MAP_WAVE_STEP);
      nodes.push({ level, chapterNum, slotIdx, gate, x, y });
      y += MAP_NODE_GAP;
      globalIdx++;
    });
    y += MAP_CHAPTER_PAD;
    // regionEnd marks where this chapter's own background wash stops —
    // lets each stretch of the map read as its own place rather than every
    // chapter sitting on one flat, undifferentiated background.
    banners.push({ chapterNum, y: bannerY, regionEnd: y });
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
  // Was a hardcoded 1000 here, disconnected from content.js's own
  // CONTENT_CEILING_LEVELS constant — bumping that constant alone silently
  // did nothing to the World Map, since this never read it. Now it does.
  const ceilingChapters = Math.ceil(CONTENT_CEILING_LEVELS/CHAPTER_SIZE);
  const totalToShow = Math.min(ceilingChapters, Math.max(3, unlockedChapters + 2));

  const chapterNums = Array.from({ length: totalToShow }, (_, i)=>i+1);
  const chaptersData = await Promise.all(chapterNums.map(async ch=>{
    const { levels, gate } = await getChapter(mode.id, ch);
    return { chapterNum: ch, levels, gate };
  }));
  if(nav.mode !== mode.id) return; // player navigated away while this was loading

  const { nodes, banners, totalHeight } = buildMapLayout(chaptersData);
  track.style.height = totalHeight + 'px';

  // Region washes first, so they sit behind everything as real atmosphere
  // per chapter instead of one flat, undifferentiated background for the
  // whole scroll — each chapter now visibly reads as its own place.
  const washesHTML = banners.map(b=>{
    const color = theme.chapterColor(b.chapterNum);
    return `<div class="map-region-wash" style="top:${b.y}px; height:${b.regionEnd-b.y}px; --band-color:${color}"></div>`;
  }).join('');

  // Dual-layer path: a wide, blurred, low-opacity glow underneath a thin
  // crisp line on top — a lit trail rather than a wireframe sketch. Three
  // small lights travel the trail continuously (native SVG animateMotion —
  // hardware-accelerated, no per-frame JS) so the map reads as a place
  // with something actually happening in it, not a static diagram.
  const pathD = buildMapPathD(nodes.map(n=>({x:n.x,y:n.y})));
  const flowDot = (dur, begin, r) => `
    <circle r="${r}" class="map-flow-dot">
      <animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" rotate="auto">
        <mpath href="#mapTrailPath"/>
      </animateMotion>
    </circle>`;
  const pathHTML = `<svg class="map-path-svg" viewBox="0 0 100 ${totalHeight}" preserveAspectRatio="none">
    <path d="${pathD}" class="map-path-glow" fill="none" stroke-linecap="round"/>
    <path id="mapTrailPath" d="${pathD}" class="map-path-line" fill="none" stroke-linecap="round"/>
    ${flowDot(9, 0, 1.6)}${flowDot(9, -3, 1.3)}${flowDot(9, -6, 1.1)}
  </svg>`;

  track.innerHTML = washesHTML + pathHTML;

  banners.forEach(b=>{
    const el = document.createElement('div');
    el.className = 'map-chapter-banner';
    el.style.top = b.y + 'px';
    el.style.setProperty('--band-color', theme.chapterColor(b.chapterNum));
    el.innerHTML = `
      <span class="band-medallion">${iconSVG((b.chapterNum-1)%SYMBOLS.length)}</span>
      <span class="band-text">Chapter ${b.chapterNum}</span>
      <span class="band-rule"></span>
    `;
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

    // A soft blurred ellipse "grounding" the node beneath it — the
    // cheapest possible depth cue (no 3D, no extra art) that still reads
    // as "sitting on a surface" instead of a flat sticker floating on
    // nothing.
    const shadow = document.createElement('div');
    shadow.className = 'map-node-shadow';
    shadow.style.left = n.x + '%';
    shadow.style.top = n.y + 'px';
    track.appendChild(shadow);

    const btn = document.createElement('button');
    btn.className = 'map-node'
      + (locked?' locked':'') + (isCurrent?' current':'')
      + (gateBlocked?' gated':'') + (level.finale?' finale':'');
    btn.style.left = n.x + '%';
    btn.style.top = n.y + 'px';
    btn.style.setProperty('--chapter-accent', theme.chapterColor(chapterNum));
    btn.style.setProperty('--diff-color', diffColor(level.difficultyRating));
    // Own idle-bob timing per node (see .mn-inner's animation-delay) so
    // the whole map doesn't bob in lockstep — deterministic off the
    // node's own index, not Math.random(), so it's stable across re-renders.
    btn.style.setProperty('--bob-delay', ((idx*0.37)%3.6).toFixed(2)+'s');
    if(gateBlocked){
      btn.innerHTML = `<div class="mn-inner">
        <div class="mn-icon">🔒</div><div class="mn-gate">★${gate.starsRequired}</div>
      </div>`;
      btn.addEventListener('click', ()=>{ audio.playGateSting(); showToast(`Earn ★${gate.starsRequired} in this chapter to open it.`, 1800); });
    }else{
      btn.innerHTML = `<div class="mn-inner">
        <div class="diff-dot"></div>
        <div class="mn-icon">${locked?'🔒':(level.finale?'✦':idx+1)}</div>
        ${locked?'':`<div class="mn-stars">${'★'.repeat(stars)}${'☆'.repeat(3-stars)}</div>`}
      </div>`;
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

// A plain sentence describing what to actually do, in place of the old
// "just a raw number" objective display — pilot feedback specifically
// asked for a task description before a level starts and a reminder of it
// during play. Reuses the level's own real data (target/collect/veil/
// timedSeconds), not a generic placeholder, so it's accurate for every
// mode and finale variant.
function taskDescriptionFor(level){
  const movesTxt = `${level.moves} move${level.moves===1?'':'s'}`;
  let sentence;
  if(level.objective==='collect'){
    const parts = (level.collect||[]).map(req=>`${req.count} ${SYMBOLS[req.type]?.name || 'piece'}${req.count===1?'':'s'}`);
    const list = parts.length>1
      ? parts.slice(0,-1).join(', ')+' and '+parts[parts.length-1]
      : (parts[0] || 'the marked pieces');
    sentence = `Collect ${list} within ${movesTxt}.`;
  }else if(level.objective==='veil'){
    const n = level.veil?.cells?.length || 0;
    sentence = `Free all ${n} veiled tile${n===1?'':'s'} — match beside a veiled tile to crack it, within ${movesTxt}.`;
  }else{
    sentence = `Score ${level.target}+ points within ${movesTxt}.`;
  }
  if(level.timedSeconds) sentence += ` You also have ${formatTime(level.timedSeconds)} on the clock.`;
  if(level.finale) sentence = `Stage Finale — ${sentence}`;
  return sentence;
}

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

// Gems previously had zero presence during actual play — only on the
// Modes-screen status bar and Dashboard, screens you pass through rather
// than live in. `pop` (true whenever this is a real mid-level gain, not
// just the initial render) triggers a visible flourish on the pill itself
// — the moment a gem lands should be something that visibly happens to
// the number in front of you, not just a line of toast text elsewhere.
function updateGemsHUD(pop){
  const el = $('stat-gems');
  if(!el) return;
  el.textContent = `💎 ${rewards.getGems()}`;
  if(pop){
    const pill = $('stat-gems-pill');
    pill.classList.remove('gem-pop');
    void pill.offsetWidth; // restart the animation if it's already mid-play
    pill.classList.add('gem-pop');
  }
}

function renderGameChrome(level){
  const mode = modeById(level.mode) || { name:'Faith Match' };
  $('game-level-name').textContent = level.mode==='daily-blessing'
    ? "Today's Blessing" : `LEVEL ${level.index+1} · ${level.name}`;
  $('game-mode-name').textContent = level.finale ? `${mode.name} · Stage Finale` : mode.name;
  updateGemsHUD(false);

  const task = taskDescriptionFor(level);
  const banner = $('task-banner');
  banner.textContent = task;
  banner.onclick = ()=>showToast(task, 3000);
  // Announced once as a toast the moment the level opens too — the banner
  // sitting quietly in the HUD is the "reminder", this is the "before you
  // start" read pilot feedback asked for.
  showToast(task, 3000);

  $('objective-area').innerHTML = objectiveAreaHTML(level);
  if(level.objective==='collect'){
    const row = $('collect-row');
    level.collect.forEach(req=>{
      const chip = document.createElement('div');
      chip.className = 'collect-chip';
      chip.id = 'collect-chip-'+req.type;
      chip.style.setProperty('--cc-color', SYMBOLS[req.type].color);
      chip.innerHTML = `<span class="cc-swatch">${iconSVG(req.type)}</span><span>0/${req.count}</span>`;
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
  // Edge-triggered, not level-triggered — the meter reaching full is one
  // moment the player should hear, not a sound that repeats on every HUD
  // tick while it happens to already be full.
  if(ready && !meterWasReady) audio.playMeterReady();
  meterWasReady = ready;
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
  slowMoUntil = 0; slowMoSkipNext = false; // fresh level, no leftover Slow-Mo window
  if(!level.timedSeconds) return;
  timeRemaining = level.timedSeconds;
  timerInterval = setInterval(()=>{
    if(engine.isBusy()){ /* don't tick mid-resolve, keeps it fair */ return; }
    // Slow-Mo Sand: skip every other real-second tick while active, so the
    // countdown effectively runs at half speed for its duration — a
    // cheaper, less binary alternative to Freeze's full pause.
    if(Date.now() < slowMoUntil){
      slowMoSkipNext = !slowMoSkipNext;
      if(slowMoSkipNext) return;
    }
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

const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const SWAP_COMMIT_RATIO = 0.42; // fraction of a tile-width a drag must cross to commit the swap

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

  if(skyHookArmed){
    // Two taps, not a drag — reuses the same tap-to-select highlighting as
    // normal play, just without the adjacency requirement on the second
    // tap. Never touches the pointermove/pointerup drag path below.
    if(!skyHookFirstCell){
      skyHookFirstCell = cell;
      setSelection(cell);
      showToast('Now tap where to send it.', 1800);
      return;
    }
    const first = skyHookFirstCell;
    skyHookArmed = false;
    skyHookFirstCell = null;
    document.body.classList.remove('sky-hook-mode');
    clearSelection();
    if(first.r===cell.r && first.c===cell.c){
      showToast('Sky Hook cancelled.', 1200);
      return;
    }
    engine.useSkyHook(first, cell);
    return;
  }

  const el = engine.getTileElAt(cell.r, cell.c);
  pointerStart = { x:e.clientX, y:e.clientY, cell, el };
  if(el) render.beginTileDrag(el);
  window.addEventListener('pointermove', onBoardPointerMove);
  window.addEventListener('pointerup', onBoardPointerUp, { once:true });
}
// The pressed tile follows the finger/cursor live — like actually picking
// the piece up, not just registering a swipe direction after the fact.
// Locked mostly to whichever axis you're dragging along (a small bleed on
// the cross-axis keeps it feeling like a real object rather than a rail),
// clamped to one tile-width so it can't be dragged arbitrarily far off its
// own cell.
function onBoardPointerMove(e){
  if(!pointerStart || !pointerStart.el) return;
  const dx = e.clientX - pointerStart.x, dy = e.clientY - pointerStart.y;
  const ts = render.getTileSize();
  let ox, oy;
  if(Math.abs(dx) >= Math.abs(dy)){
    ox = clamp(dx, -ts, ts);
    oy = clamp(dy*0.15, -ts*0.15, ts*0.15);
  }else{
    oy = clamp(dy, -ts, ts);
    ox = clamp(dx*0.15, -ts*0.15, ts*0.15);
  }
  render.updateTileDrag(pointerStart.el, ox, oy);
}
function onBoardPointerUp(e){
  window.removeEventListener('pointermove', onBoardPointerMove);
  if(!pointerStart) return;
  const dx = e.clientX - pointerStart.x, dy = e.clientY - pointerStart.y;
  const dist = Math.hypot(dx,dy);
  const startCell = pointerStart.cell;
  const draggedEl = pointerStart.el;
  const ts = render.getTileSize();
  pointerStart = null;

  if(dist > ts*SWAP_COMMIT_RATIO){
    let target;
    if(Math.abs(dx) > Math.abs(dy)) target = { r:startCell.r, c:startCell.c + (dx>0?1:-1) };
    else target = { r:startCell.r + (dy>0?1:-1), c:startCell.c };
    if(target.r>=0 && target.r<currentLevel.rows && target.c>=0 && target.c<currentLevel.cols){
      clearSelection();
      engine.attemptSwap(startCell, target); // its own setTileTransform takes over seamlessly from the dragged position
      return;
    }
  }
  // Not a committed swap — spring the picked-up tile back to its cell.
  if(draggedEl) render.endTileDragSnapBack(draggedEl);

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
    const { tileEls, hintEls, hintCells } = engine.getIdleVisualTargets();
    effects.idleShimmer(tileEls);
    if(hintEls && hintEls[0] && hintEls[1] && !hintClear){
      hintClear = effects.hintSparkle(hintEls[0], hintEls[1], hintCells);
      setTimeout(clearHint, 3200); // was 1700 — the old subtle pulse could afford to be brief; the new directional arrow deserves time to actually be seen
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
    if(!meta) return; // an id no longer in ITEMS (e.g. an old save) shouldn't take the whole tray down
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
  if(id==='lifeline'){
    if(lives.getLives() >= lives.getCap()){ showToast('Lives are already full.', 1400); return; }
    if(!rewards.useItem('lifeline')) return;
    lives.addLives(1);
    updateStatusBar();
    showToast('❤️ Lifeline! +1 life.', 1400);
    closeTray();
    return;
  }
  if(id==='slowMoSand'){
    if(!currentLevel.timedSeconds || !timerInterval){ showToast('Slow-Mo only works on a timed level.', 1600); return; }
    if(!rewards.useItem('slowMoSand')) return;
    slowMoUntil = Date.now() + 45000;
    showToast('⏳ Slow-Mo! Countdown halved for 45 seconds.', 1600);
    closeTray();
    return;
  }
  if(id==='skyHook'){
    if(!rewards.useItem('skyHook')) return;
    closeTray();
    skyHookArmed = true;
    skyHookFirstCell = null;
    document.body.classList.add('sky-hook-mode');
    showToast('Tap a tile, then tap where to send it.', 2000);
    return;
  }
  if(id==='refinersWard'){
    if(!rewards.useItem('refinersWard')) return;
    const ok = engine.useRefinersWard();
    if(!ok){ rewards.addItem('refinersWard', 1); showToast('No veils to crack right now.', 1400); return; }
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
  meterWasReady = false;
  showScreen('game');
  // Fire the gameplay theme the instant the screen changes, not after the
  // async WebGL board init below -- that await used to leave the outgoing
  // screen's music (map/menu theme) playing untouched for ~1.5s over an
  // already-visible, already-interactive board, then cut over abruptly.
  // That gap is exactly what read as "it starts like it was just resumed"
  // -- the audio and the visual "you're in the game now" moment need to
  // land together, not audio catching up a beat and a half late.
  audio.startAmbientPad(level.mode);
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
    // Halo Bomb's gem bonus lands immediately, mid-level — engine.js owns
    // the "chaos," not the persistent economy, so it hands the amount back
    // here the same way score/toasts already flow out via callbacks. The
    // HUD pill updates and pops in the same tick, right here — not just a
    // toast claiming it happened.
    onGemsEarned: (n)=>{ rewards.addGems(n); updateGemsHUD(true); },
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
  const stars = engine.starsFor(s.score, currentLevel.target || 1, s.movesLeft, currentLevel.moves);
  let rewardLines = [];

  if(currentLevel.mode==='daily-blessing'){
    const result = rewards.advanceDailySession(s.score);
    if(result.reward){
      rewardLines.push(`💎${result.reward.gems} + ${rewards.ITEMS[result.reward.item].emoji} ${rewards.ITEMS[result.reward.item].name}`);
      audio.playRewardChime();
      audio.playStreakSting(result.streak);
    }
  }else if(currentLevel.index!=null){
    state.recordCompletion(currentLevel.mode, currentLevel.index, stars);
    const chapter = Math.floor(currentLevel.index/CHAPTER_SIZE) + 1;
    const levelReward = rewards.rewardForLevel(stars, chapter);
    if(levelReward.gems || levelReward.item){
      let line = levelReward.gems ? `💎${levelReward.gems}` : '';
      if(levelReward.item){
        const meta = rewards.ITEMS[levelReward.item];
        line += (line ? ' + ' : '') + `${meta.emoji} ${meta.name}`;
      }
      rewardLines.push(line);
      audio.playRewardChime();
    }
    if(isChapterComplete(currentLevel, stars)){
      const chReward = rewards.rewardForChapter(chapter);
      rewardLines.push(`Chapter bonus: 💎${chReward.gems} + ${rewards.ITEMS[chReward.item].emoji} ${rewards.ITEMS[chReward.item].name}`);
      audio.playRewardChime();
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
  $('stat-gems-pill').addEventListener('click', ()=>showToast(GEMS_EXPLAINER, 2600));
  $('btn-open-account').addEventListener('click', ()=>{ audio.playUiTap(); openAccountPanel(); });
  $('btn-profile-shortcut').addEventListener('click', (e)=>{ e.stopPropagation(); audio.playUiTap(); openAccountPanel(); });
  $('btn-account-close').addEventListener('click', ()=>{ audio.playUiTap(); closeAccountPanel(); });
  $('btn-account-login').addEventListener('click', handleAccountLogin);
  $('btn-account-register').addEventListener('click', handleAccountRegister);
  $('btn-account-logout').addEventListener('click', handleAccountLogout);
  $('btn-account-sync-now').addEventListener('click', handleAccountSyncNow);
  $('btn-conflict-use-cloud').addEventListener('click', ()=>{
    if(pendingConflictState) state.replaceState(pendingConflictState);
    closeAccountConflict();
    updateStatusBar();
    showToast('Loaded your saved progress.', 1800);
  });
  $('btn-conflict-use-device').addEventListener('click', ()=>{
    closeAccountConflict();
    account.pushState();
    showToast("Kept this device's progress and saved it to your profile.", 1800);
  });
  engine.setPointerHandler(onBoardPointerDown);
  window.addEventListener('resize', ()=>{ engine.resizeBoard(); effects.resizeCanvas(); });
  window.addEventListener('orientationchange', ()=>{ engine.resizeBoard(); effects.resizeCanvas(); });
  // Retry the music unlock on *every* tap in the app, not just the buttons
  // that happen to call audio.playUiTap()/ensureAudio() themselves. On a
  // real (non-instant) network, the very first "Begin" tap can lose its
  // gesture-activation window before getMusic()'s async probe resolves
  // (see audio.js's ensureAudio() comment) -- and mode-card / world-map
  // taps (the actual next things a player touches) never called ensureAudio
  // at all, so a lost first attempt used to just stay silently stuck off
  // for the whole session unless the player happened to open Dashboard or
  // Inventory. A capture-phase listener on every pointerdown means any tap,
  // anywhere, is a fresh legitimate gesture that can retry it -- and
  // ensureAudio() itself is already a cheap no-op once music is actually
  // playing.
  document.addEventListener('pointerdown', ()=>audio.ensureAudio(), { capture: true });
}

async function initScreens(){
  await state.loadState();
  audio.setSoundEnabled(state.getSoundOn());
  theme.resetTheme();
  initSplash();
  initNav();
  refreshAccountRow(); // so the Modes-screen profile chip's guest/signed-in dot is correct from the very first screen, not just after a Dashboard visit
  showScreen('splash');
  // Background — never blocks first paint. If this device was signed in
  // before, this is what actually pulls progress back down (or prompts,
  // if this device also has real progress of its own to weigh against it).
  syncOnLoad();
}

export { initScreens };
