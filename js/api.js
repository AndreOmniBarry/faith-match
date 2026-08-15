/* ============================= BACKEND API CLIENT ============================= */
// Talks to the Python engine service for level data, the daily challenge,
// score submission and analytics. Every call has a short timeout — the game
// must never hang waiting on the network. Callers (content.js) fall back to
// a local generator whenever a call fails or times out, so the app is fully
// playable offline; the backend just makes the content smarter when reachable.

const API_BASE = (window.FAITHMATCH_API_BASE || '/api').replace(/\/$/, '');
const TIMEOUT_MS = 1500;

async function request(path, options){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  try{
    const res = await fetch(API_BASE + path, { ...options, signal: ctrl.signal });
    if(!res.ok) throw new Error('bad status ' + res.status);
    return await res.json();
  }finally{
    clearTimeout(timer);
  }
}

function fetchLevel(mode, index){
  return request(`/levels/${encodeURIComponent(mode)}/${index}`);
}
function fetchChapter(mode, chapter){
  return request(`/chapter/${encodeURIComponent(mode)}/${chapter}`);
}
function fetchDaily(){
  return request('/daily');
}
function submitScore(payload){
  return request('/score', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify(payload),
  }).catch(()=>null); // fire-and-forget from the player's point of view
}
function sendEvent(event, payload){
  return request('/analytics/event', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ event, payload: payload||null }),
  }).catch(()=>null);
}

export { fetchLevel, fetchChapter, fetchDaily, submitScore, sendEvent };
