/* ============================= PERSISTED STATE ============================= */
// Per-mode progress (unlocked levels, stars) + global settings, saved through
// localStorage, with an in-memory fallback so the game still works (just
// doesn't persist) if storage is unavailable (private browsing, quota, etc).

const STORAGE_KEY = 'faithmatch_progress_v3';

const state = {
  soundOn: true,
  modes: {}, // modeId -> { unlockedLevels:1, levelStars:{ [index]: 1-3 } }
  lives: 5,
  livesUpdatedAt: Date.now(), // regen math lives in js/lives.js
  gems: 0,
  inventory: {}, // itemId -> count, see js/rewards.js
  daily: { lastCompletedDate: null, streak: 0, session: null }, // see js/rewards.js
};

function modeState(modeId){
  if(!state.modes[modeId]) state.modes[modeId] = { unlockedLevels: 1, levelStars: {} };
  return state.modes[modeId];
}

function hasLocalStorage(){
  try{ return typeof localStorage !== 'undefined'; }catch(e){ return false; }
}

async function loadState(){
  if(!hasLocalStorage()) return state;
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const data = JSON.parse(raw);
      if(typeof data.soundOn === 'boolean') state.soundOn = data.soundOn;
      if(data.modes && typeof data.modes === 'object') Object.assign(state.modes, data.modes);
      if(typeof data.lives === 'number') state.lives = data.lives;
      if(typeof data.livesUpdatedAt === 'number') state.livesUpdatedAt = data.livesUpdatedAt;
      if(typeof data.gems === 'number') state.gems = data.gems;
      if(data.inventory && typeof data.inventory === 'object') Object.assign(state.inventory, data.inventory);
      if(data.daily && typeof data.daily === 'object') Object.assign(state.daily, data.daily);
    }
  }catch(e){ /* corrupt or inaccessible storage — start fresh rather than crash */ }
  return state;
}

async function saveState(){
  if(!hasLocalStorage()) return;
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      soundOn: state.soundOn, modes: state.modes,
      lives: state.lives, livesUpdatedAt: state.livesUpdatedAt,
      gems: state.gems, inventory: state.inventory, daily: state.daily,
    }));
  }catch(e){ /* quota exceeded, private-mode restrictions, etc — non-fatal */ }
}

function getUnlockedCount(modeId){ return modeState(modeId).unlockedLevels; }
function getStars(modeId, index){ return modeState(modeId).levelStars[index] || 0; }
function isUnlocked(modeId, index){ return index < modeState(modeId).unlockedLevels; }

function recordCompletion(modeId, index, stars){
  const m = modeState(modeId);
  m.levelStars[index] = Math.max(m.levelStars[index] || 0, stars);
  m.unlockedLevels = Math.max(m.unlockedLevels, index + 2);
  saveState();
}

function setSoundOn(v){ state.soundOn = v; saveState(); }
function getSoundOn(){ return state.soundOn; }

function getTotalStars(modeId){
  const m = modeState(modeId);
  return Object.values(m.levelStars).reduce((a,b)=>a+b, 0);
}

export {
  state, loadState, saveState, modeState,
  getUnlockedCount, getStars, isUnlocked, recordCompletion,
  setSoundOn, getSoundOn, getTotalStars,
};
