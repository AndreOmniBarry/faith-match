/* ============================= LIVES / ENERGY ============================= */
// Thin wrapper over state.js's raw lives/livesUpdatedAt fields. Regen is
// computed lazily whenever lives are read/spent — no running timer to
// manage or leak. Local only (no account system yet): this becomes
// server-authoritative once accounts + real purchases exist.

import { state, saveState } from './state.js';

const CAP = 5;
const REGEN_MS = 20 * 60 * 1000; // 20 minutes per life

function tick(){
  if(state.lives >= CAP){
    state.livesUpdatedAt = Date.now(); // keep the clock fresh at cap, nothing pending
    return;
  }
  const elapsed = Date.now() - state.livesUpdatedAt;
  const gained = Math.floor(elapsed / REGEN_MS);
  if(gained > 0){
    state.lives = Math.min(CAP, state.lives + gained);
    state.livesUpdatedAt = state.lives >= CAP ? Date.now() : state.livesUpdatedAt + gained*REGEN_MS;
    saveState();
  }
}

function getLives(){ tick(); return state.lives; }
function getCap(){ return CAP; }
function msUntilNextLife(){
  tick();
  if(state.lives >= CAP) return 0;
  return Math.max(0, REGEN_MS - (Date.now() - state.livesUpdatedAt));
}

function loseLife(){
  tick();
  const wasAtCap = state.lives >= CAP;
  state.lives = Math.max(0, state.lives - 1);
  if(wasAtCap) state.livesUpdatedAt = Date.now(); // start the regen clock now that we're below cap
  saveState();
  return state.lives;
}

function addLives(n){
  tick();
  state.lives = Math.min(CAP, state.lives + n);
  saveState();
  return state.lives;
}

function formatCountdown(ms){
  const total = Math.ceil(ms/1000);
  const m = Math.floor(total/60), s = total%60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

export { getLives, getCap, msUntilNextLife, loseLife, addLives, formatCountdown, REGEN_MS };
