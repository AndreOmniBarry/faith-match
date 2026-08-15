/* ============================= CONTENT: MODES, SYMBOLS, LEVELS ============================= */
// Level *data* is decided by the Python backend when it's reachable (see
// api.js) — it runs simulated playouts to calibrate a fair target instead of
// a hand guess. Everything in here that computes a level is the *offline
// fallback*: a simplified, dependency-free version of the same difficulty
// curve as server/app/level_gen.py, kept deliberately close to it (see the
// comments below) so a level feels the same whether or not the network is
// up. Mode metadata (name/icon/blurb) is presentation-only and lives here.

import { fetchLevel, fetchChapter, fetchDaily } from './api.js';

const SYMBOLS = [
  { emoji:'✝️', color:'var(--c-cross)', name:'Cross' },
  { emoji:'🕊️', color:'var(--c-dove)',  name:'Dove'  },
  { emoji:'❤️', color:'var(--c-heart)', name:'Heart' },
  { emoji:'⭐', color:'var(--c-star)',  name:'Star'  },
  { emoji:'👑', color:'var(--c-crown)', name:'Crown' },
  { emoji:'🙏', color:'var(--c-hands)', name:'Hands' },
  { emoji:'🔥', color:'var(--c-flame)', name:'Flame' },
  { emoji:'⚓', color:'var(--c-anchor)',name:'Anchor'},
];

const CHAPTER_SIZE = 15;

const MODES = [
  { id:'grace-path', name:'Grace Path', icon:'🌿', color:'var(--c-hands)', objective:'score',
    blurb:'The steady classic: match your way to the target before your moves run out.' },
  { id:'harvest', name:'Harvest', icon:'🌾', color:'var(--c-flame)', objective:'collect',
    blurb:'Gather what the field is offering — collect the marked symbols before you run out of moves.' },
  { id:'refiners-fire', name:"Refiner's Fire", icon:'🕯️', color:'var(--c-cross)', objective:'veil',
    blurb:'Veiled trials cover the board. Match beside them to set every one free.' },
  { id:'daily-blessing', name:'Daily Blessing', icon:'✨', color:'var(--gold)', objective:'score', daily:true,
    blurb:'One new challenge each day, the same for everyone walking with you — with a score bonus.' },
];

const modeById = (id)=>MODES.find(m=>m.id===id);

/* ---------- hand-curated opening run (Grace Path only — the first thing a
   new player sees). Every other mode, and Grace Path beyond this, is
   generated so weekly content growth is a tuning change, not authorship. ---------- */
const CURATED_GRACE_PATH = [
  { name:'A Gentle Start',  rows:8, cols:8, colors:5, moves:22, target:700  },
  { name:'Rising Faith',    rows:8, cols:8, colors:5, moves:22, target:1300 },
  { name:'Steady Hands',    rows:8, cols:8, colors:6, moves:21, target:2000 },
  { name:'Widening Path',   rows:8, cols:8, colors:6, moves:21, target:2800 },
  { name:'Deeper Waters',   rows:8, cols:8, colors:6, moves:20, target:3800 },
];

/* ---------- deterministic seeded RNG (mulberry32) so a local fallback level
   is always the same for the same (mode,index), matching the server's
   promise even when offline. ---------- */
function hashSeed(str){
  let h = 1779033703 ^ str.length;
  for(let i=0;i<str.length;i++){
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(seed){
  let a = seed;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, rng){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(rng()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// Difficulty curve — mirrors server/app/level_gen.py `_curve_shape` /
// `_ease`. DIFFICULTY_EASE must match the server constant.
const DIFFICULTY_EASE = 0.90;
const BREATHER_EVERY = 5;

function curveShape(index){
  const tier = Math.floor(index/40);
  const rows = Math.min(9, 8 + Math.floor(tier/3));
  const cols = rows;
  const colors = Math.min(SYMBOLS.length, 5 + Math.floor(tier/2));
  const ramp = Math.min(11, Math.floor(index/6));
  let moves = 24 - ramp;
  if(index % BREATHER_EVERY === 0 && index > 0) moves += 2;
  moves = Math.max(13, moves);
  const veilDensity = Math.min(0.22, Math.max(0, (index-4)*0.006));
  return { rows, cols, colors, moves, veilDensity };
}
function easeShape(shape){
  return {
    ...shape,
    moves: Math.round(shape.moves * (2 - DIFFICULTY_EASE)),
    veilDensity: Math.round(shape.veilDensity * DIFFICULTY_EASE * 10000) / 10000,
  };
}

function localFallbackLevel(mode, index){
  const shape = easeShape(curveShape(index));
  const rng = mulberry32(hashSeed(`faithmatch::${mode}::${index}`));
  // No simulated playouts offline — approximate the same target shape the
  // server would calibrate to, from board size/move budget directly.
  const cellBudget = shape.rows*shape.cols*shape.colors;
  const rawTarget = 60*shape.moves + cellBudget*9;
  const target = Math.max(200, Math.round(rawTarget * 0.72 * DIFFICULTY_EASE / 10) * 10);
  const objective = modeById(mode)?.objective || 'score';
  const names = ['A Gentle Start','Rising Faith','Steady Hands','Widening Path','Deeper Waters',
    "Refiner's Fire",'Mountain Climb','Radiant Crown','Quiet Trust','Open Doors','Living Water','New Mercies'];

  const level = {
    mode, index, name: names[index % names.length],
    rows: shape.rows, cols: shape.cols, colors: shape.colors, moves: shape.moves,
    objective, target,
    collect: null, veil: null,
    difficultyRating: Math.min(1, 0.35*(shape.rows*shape.cols)/81 + 0.30*shape.colors/SYMBOLS.length + 0.35*(1-Math.min(1,shape.moves/24))),
    offline: true,
  };

  if(objective === 'collect'){
    const kinds = seededShuffle([...Array(shape.colors).keys()], rng).slice(0,2);
    const base = 14 + Math.min(24, Math.floor(index/3));
    level.collect = kinds.map(k=>({ type:k, count: base + Math.floor(rng()*5)-2 }));
    level.target = Math.round(target*0.6);
  }else if(objective === 'veil'){
    const cells = [];
    for(let r=0;r<shape.rows;r++) for(let c=0;c<shape.cols;c++) cells.push([r,c]);
    const shuffled = seededShuffle(cells, rng);
    const n = Math.round(cells.length * shape.veilDensity);
    const layers = shape.veilDensity < 0.14 ? 1 : 2;
    level.veil = { cells: shuffled.slice(0,n).map(([r,c])=>[r,c,layers]) };
  }
  return level;
}

function curatedOverride(mode, index){
  if(mode==='grace-path' && index < CURATED_GRACE_PATH.length){
    const c = CURATED_GRACE_PATH[index];
    return { mode, index, name:c.name, rows:c.rows, cols:c.cols, colors:c.colors, moves:c.moves,
      objective:'score', target:c.target, collect:null, veil:null, difficultyRating: index/10, curated:true };
  }
  return null;
}

async function getLevel(mode, index){
  const curated = curatedOverride(mode, index);
  if(curated) return curated;
  try{
    return await fetchLevel(mode, index);
  }catch(e){
    return localFallbackLevel(mode, index);
  }
}

async function getChapter(mode, chapterNum){
  let levels;
  try{
    levels = (await fetchChapter(mode, chapterNum)).levels;
  }catch(e){
    const start = (chapterNum-1)*CHAPTER_SIZE;
    levels = [];
    for(let i=0;i<CHAPTER_SIZE;i++) levels.push(await getLevel(mode, start+i));
    return levels; // already curated via getLevel above
  }
  // Network path bypasses curatedOverride — splice the hand-tuned intro back in.
  return levels.map(lvl => curatedOverride(mode, lvl.index) || lvl);
}

function todaySeedIndex(){
  const d = new Date();
  const iso = d.toISOString().slice(0,10);
  return hashSeed(`faithmatch::daily::${iso}`) % 20000;
}

async function getDaily(){
  try{
    return await fetchDaily();
  }catch(e){
    const idx = todaySeedIndex();
    const level = localFallbackLevel('daily-blessing', idx);
    level.moves = Math.max(10, level.moves - 3);
    level.bonusMultiplier = 1.5;
    level.date = new Date().toISOString().slice(0,10);
    return level;
  }
}

export { SYMBOLS, MODES, modeById, CHAPTER_SIZE, getLevel, getChapter, getDaily };
