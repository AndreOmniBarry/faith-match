/* ============================= CONTENT: MODES, SYMBOLS, LEVELS ============================= */
// Level *data* is decided by the Python backend when it's reachable (see
// api.js) — it runs simulated playouts to calibrate a fair target instead of
// a hand guess. Everything in here that computes a level is the *offline
// fallback*: a simplified, dependency-free version of the same difficulty
// curve as server/app/level_gen.py, kept deliberately close to it (see the
// comments below) so a level feels the same whether or not the network is
// up. Mode metadata (name/icon/blurb) is presentation-only and lives here.

import { fetchLevel, fetchChapter, fetchDaily } from './api.js';

// This build's documented content range — see server/app/level_gen.py for
// why this isn't hand-authored rows, and why 100000 is a practical
// "effectively endless" safety bound rather than a real limit. Must match
// the server exactly.
const CONTENT_CEILING_LEVELS = 100000;

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
// `_ease` / `_chapter_ease`. CHAPTER_EASE_TABLE and the constants below it
// must match the server's exactly (same values, same names) — this offline
// fallback exists so a level feels the same whether or not the network is
// up, per this file's header comment. Lower ease = kinder (more bonus
// moves, fewer veils, lower score target); chapters 1-3 are a deliberately
// gentle onboarding, later chapters step up in distinct bands rather than
// one smooth continuous ramp. Finale levels (last CHAPTER_TAIL of a
// chapter) add FINALE_EASE_BUMP on top of their own chapter's ease instead
// of a flat global bump.
const CHAPTER_EASE_TABLE = {
  1:0.72, 2:0.72, 3:0.72,
  4:0.85, 5:0.85, 6:0.85,
  7:0.95, 8:0.95, 9:0.95,
  10:1.05, 11:1.05, 12:1.05,
  13:1.15, 14:1.15, 15:1.15,
};
const CHAPTER_EASE_TAIL_CHAPTER = 15;
const CHAPTER_EASE_TAIL_VALUE = 1.15;
const CHAPTER_EASE_TAIL_STEP = 0.015;
const CHAPTER_EASE_CAP = 1.45;
const FINALE_EASE_BUMP = 0.15;
const MIN_MOVES_FLOOR = 10; // absolute floor, independent of ease — see level_gen.py's DAILY bug postmortem
function chapterEase(chapter){
  if(CHAPTER_EASE_TABLE[chapter] != null) return CHAPTER_EASE_TABLE[chapter];
  if(chapter < 1) return CHAPTER_EASE_TABLE[1];
  const extra = CHAPTER_EASE_TAIL_VALUE + CHAPTER_EASE_TAIL_STEP*(chapter - CHAPTER_EASE_TAIL_CHAPTER);
  return Math.min(CHAPTER_EASE_CAP, extra);
}
const BREATHER_EVERY = 5;
const CHAPTER_TAIL = 3; // last N levels of a chapter are the "finale"

const FINALE_PIECES = ['wildcard','lockedChain','doublePoints','shrinking'];
const FINALE_TASKS = ['score','collect','veil','timed'];
const FINALE_SKINS = ['dawn','ember','tempest','hallowed','midnight','harvest'];
const FINALE_CONSTRAINTS = ['tighterMoves','hazardTile','raisedTarget','moreColors','noEasing'];
const pickFrom = (arr, rng)=>arr[Math.floor(rng()*arr.length)];

function curveShape(index){
  const tier = Math.floor(index/40);
  const rows = Math.min(9, 8 + Math.floor(tier/3));
  const cols = rows;
  const colors = Math.min(SYMBOLS.length, 5 + Math.floor(tier/2));
  const ramp = Math.min(11, Math.floor(index/6));
  let moves = 24 - ramp;
  if(index % BREATHER_EVERY === 0 && index > 0) moves += 2;
  moves = Math.max(13, moves);
  // Floored at 0.08, not 0 — see server/app/level_gen.py for why.
  const veilDensity = Math.min(0.22, 0.08 + index*0.0035);
  return { rows, cols, colors, moves, veilDensity };
}
function easeShape(shape, ease){
  return {
    ...shape,
    moves: Math.max(MIN_MOVES_FLOOR, Math.round(shape.moves * (2 - ease))),
    veilDensity: Math.round(shape.veilDensity * ease * 10000) / 10000,
  };
}
function veilCellsFor(shape, rng, density){
  const cells = [];
  for(let r=0;r<shape.rows;r++) for(let c=0;c<shape.cols;c++) cells.push([r,c]);
  const shuffled = seededShuffle(cells, rng);
  const n = Math.round(cells.length * density);
  const layers = density < 0.14 ? 1 : 2;
  return shuffled.slice(0,n).map(([r,c])=>[r,c,layers]);
}

/* ---------- offline target calibration ----------
   The server does not guess a score target: server/app/level_gen.py runs a
   batch of simulated playouts of the candidate board and sets the target to
   a fraction of what a mixed-skill player actually scores. This is a port of
   that simulator, so the offline fallback calibrates its targets the same
   way instead of approximating them.

   It replaces a closed-form guess (`60*moves + rows*cols*colors*9`) that was
   not just imprecise but *inverted*: it rose with board size and colour
   count, while the achievable score falls as the move budget tightens and
   the palette widens. Offline and online therefore diverged further the
   deeper a player got — measured against the server at level 501, the
   offline target was 6650 where the server asked 480, about 14x. Since the
   offline path is the common one on a cold serverless start (see this
   file's header), that curve was the one most players would actually meet.

   Deliberately mirrors the server's rules, not the full client engine: no
   specials, no veils, no combo meter. Both sides estimate the same baseline
   scoring, which is what makes the two targets comparable. */
const SIM_PLAYOUTS = 7;            // server runs 18; 7 keeps the median stable while staying well inside a frame budget on a weak phone
const SIM_RANDOM_MOVE_CHANCE = 0.22; // fraction of moves a simulated "average player" plays sub-optimally — must match the server

const simIdx = (cols, r, c)=>r*cols + c;

function simGenBoard(rng, rows, cols, colors){
  const b = new Int16Array(rows*cols);
  const wouldRun = (r,c,t)=>{
    if(c>=2 && b[simIdx(cols,r,c-1)]===t && b[simIdx(cols,r,c-2)]===t) return true;
    if(r>=2 && b[simIdx(cols,r-1,c)]===t && b[simIdx(cols,r-2,c)]===t) return true;
    return false;
  };
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    let t = 0;
    for(let k=0;k<30;k++){ t = Math.floor(rng()*colors); if(!wouldRun(r,c,t)) break; }
    b[simIdx(cols,r,c)] = t;
  }
  return b;
}

function simLineRun(b, rows, cols, r, c){
  const t = b[simIdx(cols,r,c)];
  let run = 1;
  for(let cc=c-1; cc>=0 && b[simIdx(cols,r,cc)]===t; cc--) run++;
  for(let cc=c+1; cc<cols && b[simIdx(cols,r,cc)]===t; cc++) run++;
  if(run>=3) return run;
  run = 1;
  for(let rr=r-1; rr>=0 && b[simIdx(cols,rr,c)]===t; rr--) run++;
  for(let rr=r+1; rr<rows && b[simIdx(cols,rr,c)]===t; rr++) run++;
  return run>=3 ? run : 1;
}

function simPointsFor(length){ return 30 + (length-3)*40; }

function simHasMove(b, rows, cols){
  const swapOk = (r1,c1,r2,c2)=>{
    const i1 = simIdx(cols,r1,c1), i2 = simIdx(cols,r2,c2);
    if(b[i1]===b[i2]) return false;
    const t1 = b[i1]; b[i1] = b[i2]; b[i2] = t1;
    const ok = simLineRun(b,rows,cols,r1,c1)>=3 || simLineRun(b,rows,cols,r2,c2)>=3;
    const t2 = b[i1]; b[i1] = b[i2]; b[i2] = t2;
    return ok;
  };
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    if(c+1<cols && swapOk(r,c,r,c+1)) return true;
    if(r+1<rows && swapOk(r,c,r+1,c)) return true;
  }
  return false;
}

// Scores every run >=3 on the board, clears them, refills from the top, and
// repeats — each further round of the same move scores 40% more, matching
// the engine's combo multiplier.
function simResolveCascades(b, rows, cols, colors, rng){
  let score = 0, combo = 0;
  for(;;){
    const matched = new Set();
    let any = false;
    for(let r=0;r<rows;r++){
      let c = 0;
      while(c<cols){
        const t = b[simIdx(cols,r,c)];
        let c2 = c+1;
        while(c2<cols && b[simIdx(cols,r,c2)]===t) c2++;
        if(c2-c>=3){ any = true; score += Math.round(simPointsFor(c2-c)*(1+0.4*combo));
          for(let k=c;k<c2;k++) matched.add(simIdx(cols,r,k)); }
        c = c2;
      }
    }
    for(let c=0;c<cols;c++){
      let r = 0;
      while(r<rows){
        const t = b[simIdx(cols,r,c)];
        let r2 = r+1;
        while(r2<rows && b[simIdx(cols,r2,c)]===t) r2++;
        if(r2-r>=3){ any = true; score += Math.round(simPointsFor(r2-r)*(1+0.4*combo));
          for(let k=r;k<r2;k++) matched.add(simIdx(cols,k,c)); }
        r = r2;
      }
    }
    if(!any) break;
    combo++;
    matched.forEach(i=>{ b[i] = -1; });
    for(let c=0;c<cols;c++){
      let write = rows-1;
      for(let r=rows-1;r>=0;r--){
        const v = b[simIdx(cols,r,c)];
        if(v!==-1){ b[simIdx(cols,write,c)] = v; if(write!==r) b[simIdx(cols,r,c)] = -1; write--; }
      }
      for(let r=write;r>=0;r--) b[simIdx(cols,r,c)] = Math.floor(rng()*colors);
    }
  }
  return score;
}

// Greedy = take the longest run available (an optimal-ish player); otherwise
// any legal swap at random (an average one). Mixing the two is what makes
// the median a realistic target rather than a best-case one.
function simPickSwap(b, rows, cols, rng, greedy){
  const candidates = [];
  let top = 0;
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    for(const [dr,dc] of [[0,1],[1,0]]){
      const r2 = r+dr, c2 = c+dc;
      if(r2>=rows || c2>=cols) continue;
      const i1 = simIdx(cols,r,c), i2 = simIdx(cols,r2,c2);
      if(b[i1]===b[i2]) continue;
      const t1 = b[i1]; b[i1] = b[i2]; b[i2] = t1;
      const best = Math.max(simLineRun(b,rows,cols,r,c), simLineRun(b,rows,cols,r2,c2));
      const t2 = b[i1]; b[i1] = b[i2]; b[i2] = t2;
      if(best>=3){ candidates.push([i1,i2,best]); if(best>top) top = best; }
    }
  }
  if(!candidates.length) return null;
  const pool = greedy ? candidates.filter(x=>x[2]===top) : candidates;
  return pool[Math.floor(rng()*pool.length)];
}

function simPlayout(rows, cols, colors, moves, rng){
  const b = simGenBoard(rng, rows, cols, colors);
  let score = 0;
  for(let m=0;m<moves;m++){
    if(!simHasMove(b, rows, cols)){
      const flat = seededShuffle(Array.from(b), rng);
      for(let i=0;i<flat.length;i++) b[i] = flat[i];
      continue;
    }
    const swap = simPickSwap(b, rows, cols, rng, rng() > SIM_RANDOM_MOVE_CHANCE);
    if(!swap) break;
    const [i1,i2] = swap;
    const t = b[i1]; b[i1] = b[i2]; b[i2] = t;
    score += simResolveCascades(b, rows, cols, colors, rng);
  }
  return score;
}

// Same shape as the server's _calibrate_target(): the median of a batch of
// playouts, scaled by 0.72 * ease. Reachable without perfect play, still a
// real goal — and it now moves the same direction the achievable score does.
function calibrateTarget(shape, rng, ease){
  const scores = [];
  for(let i=0;i<SIM_PLAYOUTS;i++) scores.push(simPlayout(shape.rows, shape.cols, shape.colors, shape.moves, rng));
  scores.sort((a,b)=>a-b);
  const median = scores[Math.floor(scores.length/2)];
  return Math.max(200, Math.round(median * 0.72 * ease / 10) * 10);
}

function applyFinale(level, shape, mods, rng){
  level.finalePiece = mods.piece;
  level.skin = mods.skin;
  level.finale = true;

  if(mods.piece==='lockedChain'){
    const extra = veilCellsFor(shape, rng, 0.10);
    level.veil = { cells: (level.veil?.cells||[]).concat(extra) };
  }else if(mods.piece==='doublePoints'){
    level.bonusMultiplier = 2.0;
  }else if(mods.piece==='shrinking'){
    const cells = [];
    for(let r=0;r<shape.rows;r++) for(let c=0;c<shape.cols;c++) cells.push([r,c]);
    level.shrinkCells = seededShuffle(cells, rng).slice(0,4);
  }

  if(mods.task==='timed') level.timedSeconds = 300;

  if(mods.constraint==='tighterMoves') level.moves = Math.max(MIN_MOVES_FLOOR, Math.round(level.moves*0.85));
  else if(mods.constraint==='hazardTile'){
    const extra = veilCellsFor(shape, rng, 0.08);
    level.veil = { cells: (level.veil?.cells||[]).concat(extra) };
  }else if(mods.constraint==='raisedTarget') level.target = Math.round(level.target*1.4);
  else if(mods.constraint==='moreColors') level.colors = Math.min(SYMBOLS.length, level.colors+1);
}

function localFallbackLevel(mode, index){
  const slotInChapter = index % CHAPTER_SIZE;
  const isFinale = slotInChapter >= CHAPTER_SIZE - CHAPTER_TAIL;
  const chapter = Math.floor(index/CHAPTER_SIZE) + 1;
  const ease = Math.min(CHAPTER_EASE_CAP, chapterEase(chapter) + (isFinale ? FINALE_EASE_BUMP : 0));
  const rawShape = curveShape(index);
  const shape = easeShape(rawShape, ease);
  const rng = mulberry32(hashSeed(`faithmatch::${mode}::${index}`));
  // Its own RNG stream, so adding the simulation didn't shift the veil and
  // collect layouts every existing offline level already generates.
  const target = calibrateTarget(shape, mulberry32(hashSeed(`sim::${mode}::${index}`)), ease);
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
    level.veil = { cells: veilCellsFor(shape, rng, shape.veilDensity) };
  }

  if(isFinale){
    const chapter = Math.floor(index/CHAPTER_SIZE) + 1;
    const slot = slotInChapter - (CHAPTER_SIZE - CHAPTER_TAIL);
    const modRng = mulberry32(hashSeed(`finale::${mode}::${chapter}::${slot}`));
    const mods = { piece:pickFrom(FINALE_PIECES,modRng), task:pickFrom(FINALE_TASKS,modRng),
      skin:pickFrom(FINALE_SKINS,modRng), constraint:pickFrom(FINALE_CONSTRAINTS,modRng) };
    applyFinale(level, shape, mods, rng);
  }
  return level;
}

function chapterGate(mode, chapterNum){
  const rng = mulberry32(hashSeed(`gate::${mode}::${chapterNum}`));
  if(rng() > 0.4) return null;
  const position = 9 + Math.floor(rng()*(CHAPTER_SIZE-9)); // 0-indexed, levels 10-15
  const maxStarsSoFar = position*3;
  const threshold = Math.round(maxStarsSoFar * (0.55 + rng()*0.10));
  return { position, starsRequired: threshold };
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
  let levels, gate;
  try{
    const res = await fetchChapter(mode, chapterNum);
    levels = res.levels; gate = res.gate;
  }catch(e){
    const start = (chapterNum-1)*CHAPTER_SIZE;
    levels = [];
    for(let i=0;i<CHAPTER_SIZE;i++) levels.push(await getLevel(mode, start+i));
    return { levels, gate: chapterGate(mode, chapterNum) }; // already curated via getLevel above
  }
  // Network path bypasses curatedOverride — splice the hand-tuned intro back in.
  return { levels: levels.map(lvl => curatedOverride(mode, lvl.index) || lvl), gate };
}

// Daily Blessing is one challenge, once a day — carpe diem, not a session
// to grind through. (Was a 3-level session; reverted per direction.)
const DAILY_SESSION_LENGTH = 1;

// Mirrors server/app/level_gen.py get_daily_level() — Daily gets its own
// fixed, tuned difficulty band, deliberately *not* derived from the global
// tier curve. The old approach hashed the date into an arbitrary index
// across a 20000-level span, and curveShape()'s hardest values saturate by
// index~250 — so the overwhelming majority of dates rolled max-tier
// difficulty (confirmed directly: one date produced a 9x9/8-color board
// with an 11-move budget after the old -3 penalty on top). The date-hash
// now only picks *flavor* (name + small jitter on colors/moves), the shape
// itself stays inside a moderate, always-approachable band.
const DAILY_EASE = 0.85;
const DAILY_ROWS = 8, DAILY_COLS = 8;
const DAILY_COLORS_CHOICES = [5,6,6,6,7];
const DAILY_MOVES_CHOICES = [18,19,20,20,20,21,22];
function dailyFallbackLevel(dateISO){
  const rng = mulberry32(hashSeed(`faithmatch::daily::${dateISO}`));
  const pick = (arr)=>arr[Math.floor(rng()*arr.length)];
  const rawShape = { rows:DAILY_ROWS, cols:DAILY_COLS, colors:pick(DAILY_COLORS_CHOICES), moves:pick(DAILY_MOVES_CHOICES), veilDensity:0 };
  const shape = easeShape(rawShape, DAILY_EASE);
  // Same simulated calibration localFallbackLevel uses — see calibrateTarget().
  const target = calibrateTarget(shape, mulberry32(hashSeed(`sim::daily::${dateISO}`)), DAILY_EASE);
  const names = ['A Gentle Start','Rising Faith','Steady Hands','Widening Path','Deeper Waters',
    "Refiner's Fire",'Mountain Climb','Radiant Crown','Quiet Trust','Open Doors','Living Water','New Mercies'];
  return {
    mode:'daily-blessing', index:0, name: names[Math.floor(rng()*names.length)],
    rows: shape.rows, cols: shape.cols, colors: shape.colors, moves: shape.moves,
    objective:'score', target, collect:null, veil:null,
    difficultyRating: Math.min(1, 0.35*(shape.rows*shape.cols)/81 + 0.30*shape.colors/SYMBOLS.length + 0.35*(1-Math.min(1,shape.moves/24))),
    offline: true,
  };
}

async function getDaily(){
  try{
    return await fetchDaily();
  }catch(e){
    const today = new Date().toISOString().slice(0,10);
    const levels = [];
    for(let i=0;i<DAILY_SESSION_LENGTH;i++){
      const level = dailyFallbackLevel(today);
      level.bonusMultiplier = Math.max(level.bonusMultiplier||1, 1.5);
      level.date = today;
      level.dailySlot = i;
      levels.push(level);
    }
    return { date: today, levels };
  }
}

export {
  SYMBOLS, MODES, modeById, CHAPTER_SIZE, CONTENT_CEILING_LEVELS,
  getLevel, getChapter, getDaily,
};
