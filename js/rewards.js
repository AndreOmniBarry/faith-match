/* ============================= GEMS + INVENTORY + DAILY STREAK ============================= */
// The reward economy: gems (earn/spend), the inventory item registry, and
// Daily Blessing's session/streak bookkeeping. No real-money purchase here
// — that's a later build — but everything else actually works today.

import { state, saveState } from './state.js';

const LIFE_REFILL_COST = 30;
const CONTINUE_COST = 20;
const CONTINUE_MOVES = 5;

const ITEMS = {
  extraMoves:     { id:'extraMoves',     name:'Extra Moves',      emoji:'➕', desc:'+3 moves, right now.' },
  hammer:         { id:'hammer',         name:'Giant Hammer',     emoji:'🔨', desc:'Smash any one tile on the board.' },
  rainbowShuffle: { id:'rainbowShuffle', name:'Rainbow Shuffle',  emoji:'🌈', desc:'Reshuffle the board toward a good move.' },
  colorBombGift:  { id:'colorBombGift',  name:'Color Bomb Gift',  emoji:'🎁', desc:'Drop a free Color Bomb onto the board.' },
  freeze:         { id:'freeze',         name:'Freeze',           emoji:'❄️', desc:'Pause a countdown level for 60 seconds.' },
};
const ITEM_IDS = Object.keys(ITEMS);

/* ---------- gems ---------- */
function getGems(){ return state.gems; }
function addGems(n){ state.gems += n; saveState(); return state.gems; }
function spendGems(n){
  if(state.gems < n) return false;
  state.gems -= n; saveState();
  return true;
}

/* ---------- inventory ---------- */
function getInventory(){ return { ...state.inventory }; }
function getItemCount(id){ return state.inventory[id] || 0; }
function addItem(id, n=1){
  state.inventory[id] = (state.inventory[id]||0) + n;
  saveState();
}
function useItem(id){
  if((state.inventory[id]||0) <= 0) return false;
  state.inventory[id]--;
  saveState();
  return true;
}
function grantRandomItem(){
  const id = ITEM_IDS[Math.floor(Math.random()*ITEM_IDS.length)];
  addItem(id, 1);
  return id;
}

/* ---------- level/chapter/daily reward tables ---------- */
const GEMS_BY_STARS = { 0:0, 1:5, 2:10, 3:20 };
function rewardForLevel(stars){ return GEMS_BY_STARS[stars] || 0; }
function rewardForChapter(){
  const gems = 40;
  addGems(gems);
  const item = grantRandomItem();
  return { gems, item };
}

/* ---------- daily session + streak ---------- */
function todayISO(){ return new Date().toISOString().slice(0,10); }
function yesterdayISO(fromISO){
  const d = new Date(fromISO); d.setUTCDate(d.getUTCDate()-1);
  return d.toISOString().slice(0,10);
}

function getDailyStatus(){
  const today = todayISO();
  if(!state.daily.session || state.daily.session.date !== today){
    state.daily.session = { date: today, levelIndex: 0, scoreTotal: 0, completed: false };
    saveState();
  }
  return { streak: state.daily.streak, lastCompletedDate: state.daily.lastCompletedDate, session: state.daily.session, today };
}
function isDailySessionDone(){ return getDailyStatus().session.completed; }
function getDailySessionLevelIndex(){ return getDailyStatus().session.levelIndex; }

const DAILY_SESSION_LENGTH = 1; // one challenge per day — see js/content.js

function advanceDailySession(scoreGained){
  const status = getDailyStatus();
  const s = state.daily.session;
  s.levelIndex++;
  s.scoreTotal += scoreGained;
  let reward = null;
  if(s.levelIndex >= DAILY_SESSION_LENGTH){
    s.completed = true;
    if(state.daily.lastCompletedDate === yesterdayISO(s.date)) state.daily.streak++;
    else if(state.daily.lastCompletedDate !== s.date) state.daily.streak = 1;
    state.daily.lastCompletedDate = s.date;
    const gems = 25 + state.daily.streak*5;
    addGems(gems);
    const item = grantRandomItem();
    reward = { gems, item };
  }
  saveState();
  return { session: s, streak: state.daily.streak, reward };
}

export {
  ITEMS, LIFE_REFILL_COST, CONTINUE_COST, CONTINUE_MOVES,
  getGems, addGems, spendGems,
  getInventory, getItemCount, addItem, useItem, grantRandomItem,
  rewardForLevel, rewardForChapter,
  getDailyStatus, isDailySessionDone, getDailySessionLevelIndex, advanceDailySession,
};
