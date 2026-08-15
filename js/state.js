/* ============================= PERSISTED STATE ============================= */
// Per-mode progress (unlocked levels, stars) + global settings, saved through
// window.storage when the host provides it, with an in-memory fallback so the
// game still works (just doesn't persist) in a plain browser tab.

const STORAGE_KEY = 'faithmatch_progress_v2';

const state = {
  soundOn: true,
  modes: {}, // modeId -> { unlockedLevels:1, levelStars:{ [index]: 1-3 } }
};

function modeState(modeId){
  if(!state.modes[modeId]) state.modes[modeId] = { unlockedLevels: 1, levelStars: {} };
  return state.modes[modeId];
}

async function loadState(){
  if(!window.storage){ return state; }
  try{
    const res = await window.storage.get(STORAGE_KEY);
    if(res && res.value){
      const data = JSON.parse(res.value);
      if(typeof data.soundOn === 'boolean') state.soundOn = data.soundOn;
      if(data.modes && typeof data.modes === 'object') Object.assign(state.modes, data.modes);
    }
  }catch(e){ /* no saved progress yet — start fresh */ }
  return state;
}

async function saveState(){
  if(!window.storage) return;
  try{
    await window.storage.set(STORAGE_KEY, JSON.stringify({ soundOn: state.soundOn, modes: state.modes }));
  }catch(e){ /* non-fatal */ }
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

export {
  state, loadState, saveState, modeState,
  getUnlockedCount, getStars, isUnlocked, recordCompletion,
  setSoundOn, getSoundOn,
};
