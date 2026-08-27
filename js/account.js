/* ============================= ACCOUNT: cross-device profile ============================= */
// Username + password, no email — see the Player Profiles plan for why.
// This module owns talking to the /api/account/* endpoints and the local
// session token; it does NOT own deciding when to prompt the player about
// a sync conflict — that's screens.js, same separation as everywhere else
// in this codebase (rules/data modules stay UI-free).
//
// Sync model: last-write-wins, timestamped. Every local save (any
// saveState() call anywhere in the app, via state.js's onSave hook)
// schedules a debounced push here if signed in — the player never has to
// think about "syncing," it just happens a few seconds after anything
// changes. Pulling only happens explicitly (login, or the sync-on-load
// check screens.js runs at startup) so a background push never surprises
// a player mid-level by silently overwriting what they're doing.

import { snapshot, onSave } from './state.js';

const API_BASE = (window.FAITHMATCH_API_BASE || '/api').replace(/\/$/, '');
// Account actions are explicit, occasional user gestures (tap "Log In"),
// not a background level-fetch — worth a more patient timeout than
// api.js's 1500ms, which exists specifically so gameplay never hangs.
const TIMEOUT_MS = 8000;
const TOKEN_KEY = 'faithmatch_account_v1'; // separate from state.js's save key on purpose — see its comment
const PUSH_DEBOUNCE_MS = 3000;

let token = null;
let username = null;
let pushTimer = null;

function loadToken(){
  try{
    const raw = localStorage.getItem(TOKEN_KEY);
    if(!raw) return;
    const data = JSON.parse(raw);
    token = data.token || null;
    username = data.username || null;
  }catch(e){ /* corrupt/inaccessible storage — just start signed out */ }
}
function persistToken(){
  try{
    if(token) localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, username }));
    else localStorage.removeItem(TOKEN_KEY);
  }catch(e){ /* non-fatal */ }
}
loadToken();

async function request(path, options){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  try{
    const res = await fetch(API_BASE + path, { ...options, signal: ctrl.signal });
    const body = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(body.detail || `Request failed (${res.status})`);
    return body;
  }finally{
    clearTimeout(timer);
  }
}
function authHeaders(){ return token ? { 'Authorization': 'Bearer '+token } : {}; }

function isLoggedIn(){ return !!token; }
function getUsername(){ return username; }

async function register(user, password){
  const body = await request('/account/register', {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    // Uploads this device's current save as the account's starting cloud
    // state — the natural thing for the *first* device to do; a second
    // device logs in instead and pulls it down.
    body: JSON.stringify({ username:user, password, state: snapshot() }),
  });
  token = body.token; username = user;
  persistToken();
  return body;
}

async function login(user, password){
  const body = await request('/account/login', {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ username:user, password }),
  });
  token = body.token; username = user;
  persistToken();
  return body; // { state, updatedAt } -- screens.js decides pull vs. keep-local
}

function logout(){
  if(token) request('/account/logout', { method:'POST', headers: authHeaders() }).catch(()=>{});
  token = null; username = null;
  persistToken();
  clearTimeout(pushTimer);
}

// null if never synced from any device yet (a brand-new account).
async function pullState(){
  if(!token) return null;
  return request('/account/state', { headers: authHeaders() });
}

async function pushState(){
  if(!token) return null;
  return request('/account/sync', {
    method:'POST', headers:{ ...authHeaders(), 'Content-Type':'application/json' },
    body: JSON.stringify({ state: snapshot(), updatedAt: Date.now()/1000 }),
  }).catch(()=>null); // a background sync failing should never interrupt gameplay
}

function schedulePush(){
  if(!token) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushState, PUSH_DEBOUNCE_MS);
}

// Fires after every local saveState() anywhere in the app (recordCompletion,
// addGems, useItem, ...) — none of those call sites need to know an account
// system exists at all.
onSave(schedulePush);

export { isLoggedIn, getUsername, register, login, logout, pullState, pushState };
