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
  // Each of these solves a distinct tough spot, not just a bigger number:
  lifeline:       { id:'lifeline',       name:'Lifeline',         emoji:'❤️', desc:'Instantly restore 1 life.' },
  slowMoSand:     { id:'slowMoSand',     name:'Slow-Mo Sand',     emoji:'⏳', desc:'Halve a timed level’s countdown for 45 seconds.' },
  skyHook:        { id:'skyHook',        name:'Sky Hook',         emoji:'🪝', desc:'Swap any two tiles on the board, however far apart.' },
  refinersWard:   { id:'refinersWard',   name:"Refiner's Ward",   emoji:'🛡️', desc:'Crack every crackable veil on the board at once.' },
};
const ITEM_IDS = Object.keys(ITEMS);
// Items that matter more the harder things get — weighted up at higher
// chapters (see grantRandomItem) so help arrives more generously exactly
// as the climb gets tougher, not at a flat rate the whole game.
const HIGH_IMPACT_ITEMS = ['lifeline', 'extraMoves', 'skyHook'];

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
// Weighted, not uniform — every item is always reachable (weight never
// hits 0), but the higher-impact set leans in further at higher chapters.
// chapter is 1-based; omit it (daily, or any caller without a chapter
// concept) for a flat, moderate weighting.
function grantRandomItem(chapter){
  const boost = chapter ? Math.min(6, Math.floor((chapter-1)/2)) : 1;
  const weighted = [];
  ITEM_IDS.forEach(id=>{
    const w = 2 + (HIGH_IMPACT_ITEMS.includes(id) ? boost : 0);
    for(let i=0;i<w;i++) weighted.push(id);
  });
  const id = weighted[Math.floor(Math.random()*weighted.length)];
  addItem(id, 1);
  return id;
}

/* ---------- level/chapter/daily reward tables ---------- */
// Both gems and the chance of a bonus item scale up with chapter — as the
// climb gets harder, help arrives more often, not at a flat early-game
// rate. chapter is 1-based; omit it for the old flat behavior.
const GEMS_BY_STARS = { 0:0, 1:5, 2:10, 3:20 };
// Gating this behind stars>=2 was the bug: 2 stars requires 1.25x a level's
// target, and the target itself is already calibrated to ~72% of a
// simulated player's score — so 2 stars asks for roughly 90% of that
// simulated benchmark, a high bar most real clears (usually 1-star) never
// reach. That's why the bag could read completely empty through most of a
// chapter. Every real clear (stars>=1) now gets a real, if smaller, shot;
// a stronger clear is rewarded with better odds, not an on/off gate.
function itemDropChance(stars, chapter){
  if(stars < 1) return 0;
  const base = chapter ? Math.min(0.38, 0.15 + (chapter-1)*0.01) : 0.15;
  const starMultiplier = stars>=3 ? 1.3 : stars>=2 ? 1.0 : 0.6;
  return Math.min(0.5, base*starMultiplier);
}
function rewardForLevel(stars, chapter){
  const gems = (GEMS_BY_STARS[stars] || 0) + (chapter ? Math.floor((chapter-1)/3) : 0);
  if(gems) addGems(gems);
  let item = null;
  // A bonus item on any real clear, not just a full chapter — the reason
  // the inventory used to read as permanently empty for a long stretch of
  // early play: items previously only ever came from finishing an entire
  // 15-level chapter or the daily session.
  if(stars>=1 && Math.random() < itemDropChance(stars, chapter)) item = grantRandomItem(chapter);
  return { gems, item };
}
function rewardForChapter(chapter){
  const gems = 40 + (chapter ? Math.min(60, (chapter-1)*3) : 0);
  addGems(gems);
  const item = grantRandomItem(chapter);
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
