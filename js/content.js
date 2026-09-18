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

// The first SYMBOL_COUNT of these are the whole game up to the endless range.
// The last three only ever appear once the eras start widening the palette —
// see ENDLESS_SYMBOL_COUNT in server/app/level_gen.py.
const SYMBOLS = [
  { emoji:'✝️', color:'var(--c-cross)', name:'Cross' },
  { emoji:'🕊️', color:'var(--c-dove)',  name:'Dove'  },
  { emoji:'❤️', color:'var(--c-heart)', name:'Heart' },
  { emoji:'⭐', color:'var(--c-star)',  name:'Star'  },
  { emoji:'👑', color:'var(--c-crown)', name:'Crown' },
  { emoji:'🙏', color:'var(--c-hands)', name:'Hands' },
  { emoji:'🔥', color:'var(--c-flame)', name:'Flame' },
  { emoji:'⚓', color:'var(--c-anchor)',name:'Anchor'},
  { emoji:'📜', color:'var(--c-scroll)',name:'Scroll'},
  { emoji:'🌿', color:'var(--c-olive)', name:'Olive' },
  { emoji:'💧', color:'var(--c-water)', name:'Water' },
];
// Must be the literal 8 the server uses, never SYMBOLS.length: the early
// curve's palette is part of every existing level's difficulty, so growing
// the symbol list must not widen it by a side effect.
const SYMBOL_COUNT = 8;

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
const VEIL_DENSITY_CEILING = 0.22; // most of the board a veil field may cover, before *and* after easing

// Offline stand-ins for the server's simulated collect/veil goals.
//
// The server reads those goals off Monte Carlo playouts (level_gen.py's
// _collect_ladder / _veil_ladder). There are no playouts here, and the goals
// do not reduce to a formula: a veil goal turns mostly on *which* cells a
// level veils, and fitting the calibrated numbers by board shape alone leaves
// an error of 4 pieces on a collect goal and 6 veils on a veil goal — on
// goals whose real values run from 3 to 23.
//
// So these deliberately aim low instead of aiming close. Offline is the
// degraded path, and the two ways of being wrong are not equally bad: a goal
// set under the calibrated one is a level that plays a little generously,
// while a goal set over it is the level nobody can finish that this whole
// change exists to remove. Both are checked against the simulator by
// server/tools/goal_report.py offline.
const OFFLINE_COLLECT_PER_MOVE = 2.8;  // pieces of one chased symbol per move, split over the palette
const OFFLINE_VEIL_PER_MOVE = 0.28;    // veils freed per move, halved again per extra layer

// Cut cells take matches off the board, so every goal read off the move
// budget has to be read off the board that budget is actually spent on. A
// twelve-cell cut is 15% of a 9x9, and a goal that ignores it is a goal set
// 15% over what the board gives — which on a shaped board was the difference
// between a level clearing in 20% of simulated playouts and in 60%.
function offlineBoardShare(rows, cols, cutCells){
  const area = Math.max(1, rows*cols);
  return Math.max(0.5, (area - (cutCells||0))/area);
}

function offlineCollectGoal(moves, colors, share){
  const raw = OFFLINE_COLLECT_PER_MOVE * moves / colors * (share == null ? 1 : share);
  return Math.max(3, Math.round(raw) - 1);
}
function offlineVeilRequired(moves, cells, share){
  if(!cells.length) return 0;
  const layers = Math.max(1, ...cells.map(c=>c[2]));
  const asked = Math.round(OFFLINE_VEIL_PER_MOVE * moves / layers * (share == null ? 1 : share));
  return Math.max(1, Math.min(cells.length, Math.max(2, asked)));
}

/* ---------- offline score targets.
   These used to be `0.72 * ease * (60*moves + rows*cols*colors*9)`, a guess
   at the shape of a calibrated target that was wrong in both its scale and
   its sign: it read a wider palette as a *higher* reachable score, when a
   wider palette is exactly what makes a board score less. It asked 6720 on
   the 9x9/8-colour/10-move board the server calibrates to 570, and
   server/tools/verify_offline_goals.py measured 0 of 15 playouts clearing
   it — on 300-odd levels, the whole offline score and timed range.

   So the target is read the same way every other goal is: off the
   distribution of what a simulated player actually scores. There are no
   playouts offline, so what ships here is a closed-form fit of that
   distribution, measured over 560 boards covering every size, palette, move
   budget and cut the generator produces — see server/tools/fit_offline_score.py,
   which prints these five numbers and the error spread. ---------- */
const OFFLINE_SCORE_K = 46313;         // exp(10.7454) from the log-space fit
const OFFLINE_SCORE_MOVE_EXP = 0.9869;
const OFFLINE_SCORE_FREE_EXP = 0.3064;
const OFFLINE_SCORE_COLOR_A = -6.6673; // colors^(A + B*ln colors) — a wider
const OFFLINE_SCORE_COLOR_B = 1.3203;  // palette costs less and less per step
// A goal at win rate w sits at this share of the median, measured off the
// same 560 ladders: 0.83 of the median at w=0.85, 1.06 at w=0.35, near
// enough straight in between.
const OFFLINE_SCORE_RATIO_BASE = 1.20;
const OFFLINE_SCORE_RATIO_SLOPE = 0.44;
// The fit is within about +/-9% of the measured median on 90% of boards, and
// over-predicts by at most 25% on the sparsest one — a wide palette on a
// heavily cut board. Offline is the degraded path, so the residual is spent
// on making levels generous rather than on making one of them impossible:
// this is set low enough that the worst over-prediction still lands under
// what a simulated player reaches, which costs every other offline score
// level about a tenth of its target and is the cheaper of the two mistakes.
const OFFLINE_SCORE_SAFETY = 0.78;
const OFFLINE_SCORE_MIN = 200;
// Below the endless range the server still sets score targets with its old
// `0.72 * ease * median` formula, and at the gentle end of the curve that is
// the *kinder* of the two — 0.52 of the median at a chapter-1 ease against
// the quantile read's 0.69. Offline takes whichever asks less: the server's
// own shape where the server is generous, the measured quantile where the
// formula would ask more than most players reach. A new player who drops
// offline in chapter 1 gets the level they would have got online, and nobody
// at any depth gets one the board cannot pay for.
const OFFLINE_SCORE_LEGACY_FACTOR = 0.72;

// Mirrors _goal_win_rate() and its two constants in level_gen.py.
const GOAL_WIN_RATE_EASY = 0.88;       // at the kindest ease in CHAPTER_EASE_TABLE
const GOAL_WIN_RATE_HARD = 0.55;       // at CHAPTER_EASE_CAP
function offlineWinRate(ease){
  const lo = CHAPTER_EASE_TABLE[1], hi = CHAPTER_EASE_CAP;
  const t = hi <= lo ? 0 : Math.min(1, Math.max(0, (ease - lo)/(hi - lo)));
  return GOAL_WIN_RATE_EASY + (GOAL_WIN_RATE_HARD - GOAL_WIN_RATE_EASY)*t;
}
function offlineScoreMedian(rows, cols, colors, moves, cutCells){
  const free = Math.max(1, rows*cols - (cutCells||0));
  const lc = Math.log(colors);
  return OFFLINE_SCORE_K
    * Math.pow(moves, OFFLINE_SCORE_MOVE_EXP)
    * Math.pow(free, OFFLINE_SCORE_FREE_EXP)
    * Math.exp(lc*(OFFLINE_SCORE_COLOR_A + OFFLINE_SCORE_COLOR_B*lc));
}
function offlineScoreTarget(rows, cols, colors, moves, cutCells, ease, winRateShift){
  // A "Raised Target" finale asks the same board of a smaller share of
  // players, exactly as win_rate_shift does in _endless_target().
  const win = Math.max(0.2, offlineWinRate(ease) - (winRateShift || 0));
  const ratio = OFFLINE_SCORE_RATIO_BASE - OFFLINE_SCORE_RATIO_SLOPE*win;
  const median = offlineScoreMedian(rows, cols, colors, moves, cutCells);
  const raw = Math.min(median*ratio*OFFLINE_SCORE_SAFETY,
                       median*OFFLINE_SCORE_LEGACY_FACTOR*ease);
  return Math.max(OFFLINE_SCORE_MIN, Math.round(raw/10)*10);
}
function chapterEase(chapter){
  if(CHAPTER_EASE_TABLE[chapter] != null) return CHAPTER_EASE_TABLE[chapter];
  if(chapter < 1) return CHAPTER_EASE_TABLE[1];
  // Past ENDLESS_START_CHAPTER the single ramp becomes the era sawtooth, same
  // as _chapter_ease() on the server.
  const era = eraPosition(chapter);
  if(era) return eraEase(era.era, era.t);
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
  const colors = Math.min(SYMBOL_COUNT, 5 + Math.floor(tier/2));
  const ramp = Math.min(11, Math.floor(index/6));
  let moves = 24 - ramp;
  if(index % BREATHER_EVERY === 0 && index > 0) moves += 2;
  moves = Math.max(13, moves);
  // Floored at 0.08, not 0 — see server/app/level_gen.py for why.
  const veilDensity = Math.min(VEIL_DENSITY_CEILING, 0.08 + index*0.0035);
  return { rows, cols, colors, moves, veilDensity };
}
function easeShape(shape, ease){
  return {
    ...shape,
    moves: Math.max(MIN_MOVES_FLOOR, Math.round(shape.moves * (2 - ease))),
    // Clamped back to the ceiling after easing, same as level_gen.py: ease
    // climbs to 1.45, which used to push the density to 0.32 and freeze a
    // third of the board into segments nothing falls through.
    veilDensity: Math.round(Math.min(VEIL_DENSITY_CEILING, shape.veilDensity * ease) * 10000) / 10000,
  };
}
// `exclude` keeps a finale's extra veils off cells the base field already
// veiled: the two lists could otherwise name the same cell twice, and the
// level then counted more veils than the board holds — which, now that a veil
// goal is a count of veils to free, is the difference between a hard level and
// an unwinnable one. Mirrors _place_veils() in server/app/level_gen.py.
function veilCellsFor(shape, rng, density, exclude){
  const cells = [];
  for(let r=0;r<shape.rows;r++) for(let c=0;c<shape.cols;c++) cells.push([r,c]);
  let shuffled = seededShuffle(cells, rng);
  const n = Math.round(cells.length * density);
  if(exclude && exclude.size) shuffled = shuffled.filter(([r,c])=>!exclude.has(r+','+c));
  const layers = density < 0.14 ? 1 : 2;
  return shuffled.slice(0,n).map(([r,c])=>[r,c,layers]);
}
const veilCellKeys = (cells)=>new Set((cells||[]).map(c=>c[0]+','+c[1]));

// `objective` gates the two veil-adding axes to Refiner's Fire, exactly as
// _apply_finale() does on the server. Without it, a Grace Path or Harvest
// finale generated offline drops veiled tiles onto a board with no
// veil-progress UI and no explanation, and the player just meets unexplained
// "that one is still veiled" rejections on random tiles. The server fixed
// that; this path still had it, which is why an offline finale could differ
// from the served one in its palette and its veils.
function applyFinale(level, shape, mods, rng, symbolCap = SYMBOL_COUNT, objective = 'score'){
  level.finalePiece = mods.piece;
  level.skin = mods.skin;
  level.finale = true;

  let piece = mods.piece;
  if(piece==='lockedChain' && objective!=='veil') piece = 'doublePoints';
  if(piece==='lockedChain'){
    const existing = level.veil?.cells||[];
    const extra = veilCellsFor(shape, rng, 0.10, veilCellKeys(existing));
    level.veil = { ...(level.veil||{}), cells: existing.concat(extra) };
  }else if(piece==='doublePoints'){
    level.bonusMultiplier = 2.0;
  }else if(piece==='shrinking'){
    const blocked = new Set((level.mask||[]).map(([r,c])=>r+','+c));
    const cells = [];
    for(let r=0;r<shape.rows;r++) for(let c=0;c<shape.cols;c++){
      if(!blocked.has(r+','+c)) cells.push([r,c]);
    }
    level.shrinkCells = seededShuffle(cells, rng).slice(0,4);
  }

  // 5:00 flat below the endless range; past it the clock follows the move
  // budget, same as every other timed level. Mirrors _apply_finale().
  if(mods.task==='timed') level.timedSeconds = symbolCap > SYMBOL_COUNT
    ? timedSecondsFor(level.moves) : 300;

  let constraint = mods.constraint;
  if(constraint==='hazardTile' && objective!=='veil') constraint = 'moreColors';
  if(constraint==='tighterMoves') level.moves = Math.max(MIN_MOVES_FLOOR, Math.round(level.moves*0.85));
  else if(constraint==='hazardTile'){
    const existing = level.veil?.cells||[];
    const extra = veilCellsFor(shape, rng, 0.08, veilCellKeys(existing));
    level.veil = { ...(level.veil||{}), cells: existing.concat(extra) };
  }else if(constraint==='raisedTarget'){
    if(symbolCap > SYMBOL_COUNT){
      level.target = Math.round(level.target * ENDLESS_RAISED_TARGET);
      // A note for refitOfflineGoal(), which re-reads a score target off the
      // board the finale ships and would otherwise undo the constraint.
      // localFallbackLevel drops it again before the level goes out, so no
      // level's payload grows a field over this. Mirrors _apply_finale().
      level.raisedTargetBy = ENDLESS_RAISED_TARGET;
    }else{
      level.target = Math.round(level.target * 1.4);
    }
  }
  else if(constraint==='moreColors') level.colors = Math.max(level.colors, Math.min(symbolCap, level.colors+1));
}

/* ---------- Endless progression — eras.

   Mirrors the era block in server/app/level_gen.py, and must stay in step
   with it: same constants, same shapes, same draws. The server is still the
   source of truth for a level; this is the offline fallback, so a player on a
   bad connection gets the same *kind* of level — the same objective, the same
   board shape, the same era — rather than dropping back to the flat 9x9 the
   endless range exists to replace.

   The one thing this cannot mirror is calibration: the server reads its goals
   off simulated playouts, which are far too slow to run in a phone webview
   mid-swipe. The formulas below are deliberate underestimates for the same
   reason offlineCollectGoal() is — a goal set a little under the calibrated
   one plays generously, a goal set over it is a level nobody can finish.
   server/tools/verify_offline_goals.py checks the gap against the real
   thing. ---------- */
const ENDLESS_START_CHAPTER = 41;
const ERA_CHAPTERS = 20;
const ERA_TROUGH_EASE = 1.20;
const ERA_TROUGH_DRIFT = 0.06;
const ERA_TROUGH_CEILING = CHAPTER_EASE_CAP - 0.05;
const ERA_PEAK_EASE = CHAPTER_EASE_CAP;
const ERA_SHAPE_EXP = 0.85;
const ERA_TROUGH_MOVE_BONUS = 8;
const ENDLESS_SYMBOL_COUNT = 11;
const ENDLESS_PALETTE_STEPS = [[6,3],[3,2],[1,1]];
const ENDLESS_PALETTE_MOVE_BONUS = 2;
const MASK_MAX_SHARE = 0.18;
const MASK_MIN_FREE_PER_LINE = 3;
const MASK_COUNTS = [4,8,12];
const MASK_MOVE_BONUS_PER_CELLS = 5;
const MASK_SHAPES = ['corners','ring','well','pillars','hourglass','lattice'];
const ENDLESS_OBJECTIVE_UNLOCKS = [[0,'cascade'],[1,'collect'],[1,'veil'],[2,'timed'],[2,'score']];
const ENDLESS_HOME_WEIGHT = 3;
const CASCADE_MIN_GOAL = 2;
const CASCADE_MOVE_RELIEF = 1.4;
const TIMED_SECONDS_PER_MOVE = 11;
const TIMED_MOVE_RELIEF = 1.35;
const TIMED_TARGET_RELIEF = 0.85;
const ENDLESS_TWIST_POOL = ['doublePoints','wildcard','shrinking','tighterMoves'];
const ENDLESS_TWIST_MAX = 3;
// The legacy 1.4x was sized against a formula target; an endless target comes
// off the ladder at the level's own win-rate quantile, where 1.4x lands past
// the top of what the board gives. Legacy finales keep 1.4x — it is part of
// levels players have already cleared. Mirrors ENDLESS_RAISED_TARGET.
const ENDLESS_RAISED_TARGET = 1.15;
// How much of the field a raised target takes off a score level's aim, in
// win-rate terms. Mirrors ENDLESS_RAISED_TARGET_SHIFT in level_gen.py.
const ENDLESS_RAISED_TARGET_SHIFT = 0.15;
const ERA_TITLES = ['The Wilderness','The Highlands','Deep Waters','The Citadel',
  'The Orchard','The Firmament','The Sanctuary','The Pilgrimage','The Covenant',
  'The Dayspring','The Harvest Moon','The Everlasting'];
const ERA_RELICS = [
  ['dawn-shard','Dawn Shard','🔆'], ['olive-seal','Olive Seal','🫒'],
  ['still-water','Still Water','💧'], ['iron-key','Iron Key','🗝'],
  ['first-fruit','First Fruit','🍇'], ['star-chart','Star Chart','🗺'],
  ['oil-lamp','Oil Lamp','🪔'], ['pilgrim-staff',"Pilgrim's Staff",'🦯'],
  ['stone-tablet','Stone Tablet','📜'], ['morning-bell','Morning Bell','🔔'],
  ['wheat-sheaf','Wheat Sheaf','🌾'], ['crown-of-life','Crown of Life','👑'],
];
const ENDLESS_NAME_FIRST = ['Rising','Quiet','Golden','Hidden','Steadfast','Boundless',
  'Gentle','Burning','Distant','Faithful','Radiant','Unshaken','Whispering','Endless',
  'Patient','Wondrous'];
const ENDLESS_NAME_SECOND = ['Ascent','Crossing','Vigil','Harvest','Threshold','Beacon',
  'Current','Garden','Summit','Refuge','Dawn','Passage','Ember','Wellspring','Horizon',
  'Crown','Shelter','Tide','Lantern','Covenant'];

// The objective, the board's shape and the level's name are drawn through
// hashSeed() directly rather than through mulberry32, because the server does
// the same (see _hash32 in server/app/level_gen.py). Those three are the
// level's identity: "Collect 3 Crowns" turning into "Set off 3 chains"
// because a request timed out is a different level, not a different layout,
// and no two different generators can be made to emit the same stream. What
// still comes from the seeded RNG here — a veil layout, which two symbols to
// gather — differs from the server's as it always has.
const stableUnit = (tag)=>hashSeed(tag)/4294967296;
const stablePick = (tag, options)=>options[hashSeed(tag) % options.length];

// null for every chapter before the endless range — the whole safety guarantee
// of this section, exactly as _era_position() is on the server.
function eraPosition(chapter){
  if(chapter < ENDLESS_START_CHAPTER) return null;
  const off = chapter - ENDLESS_START_CHAPTER;
  const era = Math.floor(off / ERA_CHAPTERS);
  const slot = off % ERA_CHAPTERS;
  return { era, slot, t: ERA_CHAPTERS > 1 ? slot/(ERA_CHAPTERS-1) : 1 };
}
function eraEase(era, t){
  const span = ERA_TROUGH_CEILING - ERA_TROUGH_EASE;
  const trough = ERA_TROUGH_CEILING - span*Math.exp(-ERA_TROUGH_DRIFT*era);
  return Math.round((trough + (ERA_PEAK_EASE - trough)*Math.pow(t, ERA_SHAPE_EXP))*10000)/10000;
}
function eraTitle(era){
  const cycle = Math.floor(era/ERA_TITLES.length);
  const title = ERA_TITLES[era % ERA_TITLES.length];
  return cycle ? `${title} ${cycle+1}` : title;
}
function eraRelic(era){
  const cycle = Math.floor(era/ERA_RELICS.length);
  const [id, name, emoji] = ERA_RELICS[era % ERA_RELICS.length];
  if(!cycle) return { id, name, emoji };
  const suffix = cycle < 3 ? ' ' + 'I'.repeat(cycle+1) : ` ${cycle+1}`;
  return { id: `${id}-${cycle+1}`, name: name + suffix, emoji };
}

// Grouped by symmetry orbit so a severity always lands on a complete shape —
// see _mask_candidates() in server/app/level_gen.py.
function maskCandidates(shapeId, rows, cols){
  const midR = (rows-1)/2, midC = (cols-1)/2;
  const orbit = (r,c)=>{
    const a = Math.round(Math.abs(r-midR)*1000)/1000, b = Math.round(Math.abs(c-midC)*1000)/1000;
    return [Math.min(a,b), Math.max(a,b)];
  };
  const out = [];
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    let primary = null;
    if(shapeId==='corners'){
      primary = Math.min(r+c, r+(cols-1-c), (rows-1-r)+c, (rows-1-r)+(cols-1-c));
    }else if(shapeId==='ring'){
      primary = Math.abs(Math.max(Math.abs(r-midR), Math.abs(c-midC)) - 2);
    }else if(shapeId==='well'){
      primary = Math.abs(r-midR) + Math.abs(c-midC);
    }else if(shapeId==='pillars'){
      if(c===0 || c===cols-1 || (((c - Math.floor(cols/2)) % 3) + 3) % 3 !== 0) continue;
      primary = Math.abs(r-midR);
    }else if(shapeId==='hourglass'){
      if(!(Math.abs(r-midR) < 1.2)) continue;
      primary = -Math.abs(c-midC);
    }else if(shapeId==='lattice'){
      if(((r + 2*c) % 5) !== 0 || r===0 || r===rows-1) continue;
      primary = Math.abs(r-midR) + Math.abs(c-midC);
    }else continue;
    out.push({ primary, orbit: orbit(r,c), r, c });
  }
  out.sort((a,b)=>
    a.primary-b.primary ||
    a.orbit[0]-b.orbit[0] || a.orbit[1]-b.orbit[1] ||
    a.r-b.r || a.c-b.c);
  const groups = [];
  let lastKey = null;
  out.forEach(cell=>{
    const key = `${cell.primary}|${cell.orbit[0]}|${cell.orbit[1]}`;
    if(key !== lastKey){ groups.push([]); lastKey = key; }
    groups[groups.length-1].push([cell.r, cell.c]);
  });
  return groups;
}
// No row or column may be left with fewer free cells than a match needs.
function maskTrim(cells, rows, cols){
  const kept = cells.slice();
  while(kept.length){
    const rowFree = new Array(rows).fill(cols), colFree = new Array(cols).fill(rows);
    kept.forEach(([r,c])=>{ rowFree[r]--; colFree[c]--; });
    if(Math.min(...rowFree) >= MASK_MIN_FREE_PER_LINE && Math.min(...colFree) >= MASK_MIN_FREE_PER_LINE) break;
    kept.pop();
  }
  return kept.sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
}
function boardMask(shapeId, rows, cols, severity){
  if(shapeId==='none' || severity <= 0) return [];
  const maxCells = Math.floor(rows*cols*MASK_MAX_SHARE);
  const want = Math.min(MASK_COUNTS[Math.min(severity, MASK_COUNTS.length)-1], maxCells);
  const chosen = [];
  for(const group of maskCandidates(shapeId, rows, cols)){
    if(chosen.length && (chosen.length >= want || chosen.length + group.length > maxCells)) break;
    group.forEach(cell=>chosen.push(cell));
  }
  return maskTrim(chosen, rows, cols);
}
function endlessMask(mode, index, era, t, rows, cols){
  const chance = Math.min(0.75, 0.15 + 0.12*era + 0.25*t);
  if(stableUnit(`mask::${mode}::${index}`) > chance) return [];
  const shapeId = stablePick(`mask-shape::${mode}::${index}`, MASK_SHAPES);
  const severity = 1 + Math.min(MASK_COUNTS.length-1, Math.floor((era + t*2)/2.2));
  return boardMask(shapeId, rows, cols, severity);
}
function endlessPalette(era){
  for(const [need, extra] of ENDLESS_PALETTE_STEPS) if(era >= need) return extra;
  return 0;
}
function endlessObjective(mode, index, era){
  const home = modeById(mode)?.objective || 'score';
  if(mode === 'daily-blessing') return home;
  const pool = [home, home, home].slice(0, ENDLESS_HOME_WEIGHT);
  ENDLESS_OBJECTIVE_UNLOCKS.forEach(([need, obj])=>{ if(era >= need && obj !== home) pool.push(obj); });
  return stablePick(`objective::${mode}::${index}`, pool);
}
// id -> { name, emoji } for every era relic, so the dashboard can name one a
// player is holding without knowing which era it came from. Keyed by the bare
// id; a later cycle's relic ("dawn-shard-2") resolves through the same entry.
const ERA_RELIC_LOOKUP = Object.fromEntries(
  ERA_RELICS.map(([id, name, emoji])=>[id, { name, emoji }]));

function endlessName(mode, index){
  return `${stablePick(`name-a::${mode}::${index}`, ENDLESS_NAME_FIRST)} `
       + `${stablePick(`name-b::${mode}::${index}`, ENDLESS_NAME_SECOND)}`;
}
function endlessTwists(mode, index, era, t){
  const budget = Math.min(ENDLESS_TWIST_MAX, Math.floor(era/2) + (t > 0.45 ? 1 : 0));
  if(budget <= 0) return [];
  let n = Math.floor(stableUnit(`twist-n::${mode}::${index}`)*(budget+1));
  n = Math.min(n, budget, ENDLESS_TWIST_POOL.length);
  // Rotated, not shuffled, so the same n gives the same set on both sides.
  const start = hashSeed(`twist::${mode}::${index}`) % ENDLESS_TWIST_POOL.length;
  const out = [];
  for(let i=0;i<n;i++) out.push(ENDLESS_TWIST_POOL[(start+i) % ENDLESS_TWIST_POOL.length]);
  return out;
}
// Chains a simulated average player lands, approximated. The server reads this
// off playouts; measured there, the count tracks the move budget closely once
// the board is at its 9x9 ceiling, which is the only board the endless range
// ever uses.
// Chains per move, and how fast they thin out as the palette widens. A wider
// palette makes the refill less likely to land a second match, so the penalty
// is squared rather than linear; and a chain goal is a single-digit integer,
// so the raw figure is floored rather than rounded — half a chain rounded up
// is a whole extra chain asked of a board that does not produce it. Against
// the server's calibrated goals over 134 chain levels this lands on the same
// number 88 times, one under it 30 times and one over it 16.
const OFFLINE_CASCADE_PER_MOVE = 0.175;
const OFFLINE_CASCADE_COLOR_EXP = 2.0;
function offlineCascadeGoal(moves, colors, share){
  const raw = OFFLINE_CASCADE_PER_MOVE * moves
            * Math.pow(8/Math.max(8, colors), OFFLINE_CASCADE_COLOR_EXP)
            * (share == null ? 1 : share);
  return Math.max(CASCADE_MIN_GOAL, Math.floor(raw));
}
function timedSecondsFor(moves){
  return Math.max(60, Math.round(moves*TIMED_SECONDS_PER_MOVE/5)*5);
}
function applyTwists(level, shape, twists, mask, rng){
  const blocked = new Set(mask.map(([r,c])=>r+','+c));
  twists.forEach(twist=>{
    if(twist==='doublePoints') level.bonusMultiplier = 2.0;
    else if(twist==='wildcard') level.finalePiece = 'wildcard';
    else if(twist==='shrinking'){
      const cells = [];
      for(let r=0;r<shape.rows;r++) for(let c=0;c<shape.cols;c++){
        if(!blocked.has(r+','+c)) cells.push([r,c]);
      }
      level.shrinkCells = seededShuffle(cells, rng).slice(0,4);
    }else if(twist==='tighterMoves'){
      level.moves = Math.max(MIN_MOVES_FLOOR, Math.round(level.moves*0.85));
    }
  });
  if(twists.length) level.twists = twists.slice();
}

function localFallbackLevel(mode, index){
  const slotInChapter = index % CHAPTER_SIZE;
  const isFinale = slotInChapter >= CHAPTER_SIZE - CHAPTER_TAIL;
  const chapter = Math.floor(index/CHAPTER_SIZE) + 1;
  const ease = Math.min(CHAPTER_EASE_CAP, chapterEase(chapter) + (isFinale ? FINALE_EASE_BUMP : 0));
  const rawShape = curveShape(index);
  let shape = easeShape(rawShape, ease);
  const rng = mulberry32(hashSeed(`faithmatch::${mode}::${index}`));
  const names = ['A Gentle Start','Rising Faith','Steady Hands','Widening Path','Deeper Waters',
    "Refiner's Fire",'Mountain Climb','Radiant Crown','Quiet Trust','Open Doors','Living Water','New Mercies'];

  // Everything below eraPos is the pre-endless behaviour, unchanged.
  const eraPos = eraPosition(chapter);
  let objective, name, mask = [], twists = [], era = null, symbolCap = SYMBOL_COUNT;
  if(!eraPos){
    objective = modeById(mode)?.objective || 'score';
    name = names[index % names.length];
  }else{
    objective = endlessObjective(mode, index, eraPos.era);
    name = endlessName(mode, index);
    symbolCap = ENDLESS_SYMBOL_COUNT;
    shape = { ...shape };
    shape.moves += Math.round((ERA_PEAK_EASE - ease)*ERA_TROUGH_MOVE_BONUS);
    const extra = endlessPalette(eraPos.era);
    if(extra){
      const widened = Math.min(ENDLESS_SYMBOL_COUNT, shape.colors + extra);
      shape.moves += (widened - shape.colors)*ENDLESS_PALETTE_MOVE_BONUS;
      shape.colors = widened;
    }
    mask = endlessMask(mode, index, eraPos.era, eraPos.t, shape.rows, shape.cols);
    if(mask.length) shape.moves += Math.round(mask.length/MASK_MOVE_BONUS_PER_CELLS);
    if(objective === 'timed') shape.moves = Math.max(MIN_MOVES_FLOOR, Math.round(shape.moves*TIMED_MOVE_RELIEF));
    else if(objective === 'cascade') shape.moves = Math.max(MIN_MOVES_FLOOR, Math.round(shape.moves*CASCADE_MOVE_RELIEF));
    twists = endlessTwists(mode, index, eraPos.era, eraPos.t);
    era = { index: eraPos.era, title: eraTitle(eraPos.era),
            position: Math.round(eraPos.t*1000)/1000, relic: eraRelic(eraPos.era) };
  }

  // No simulated playouts offline — the target comes from a fit of what the
  // simulator measures a player scoring on this board. See offlineScoreTarget.
  const target = offlineScoreTarget(shape.rows, shape.cols, shape.colors,
                                    shape.moves, mask.length, ease);
  const share = offlineBoardShare(shape.rows, shape.cols, mask.length);

  const boardFactor = mask.length
    ? (shape.rows*shape.cols/81)*(1 + mask.length/(shape.rows*shape.cols))
    : shape.rows*shape.cols/81;
  const level = {
    mode, index, name,
    rows: shape.rows, cols: shape.cols, colors: shape.colors, moves: shape.moves,
    objective, target,
    collect: null, veil: null,
    difficultyRating: Math.min(1, 0.35*boardFactor + 0.30*shape.colors/SYMBOL_COUNT + 0.35*(1-Math.min(1,shape.moves/24))),
    offline: true,
  };
  if(era){
    level.era = era;
    if(mask.length) level.mask = mask;
  }

  if(objective === 'collect'){
    const kinds = seededShuffle([...Array(shape.colors).keys()], rng).slice(0,2);
    // Was `14 + min(24, index/3)`, which climbed to 38 and stayed there while
    // the move budget fell to 10 — by level 300 it asked for 40 of a symbol a
    // simulated player gathers 6 of. See offlineCollectGoal above.
    const goal = offlineCollectGoal(shape.moves, shape.colors, share);
    const jitter = Math.round(goal * 0.08);
    level.collect = kinds.map(k=>({ type:k, count: Math.max(3, goal + (Math.floor(rng()*3)-1)*jitter) }));
    level.target = Math.round(target*0.6);
  }else if(objective === 'veil'){
    const cells = veilCellsFor(shape, rng, shape.veilDensity,
      new Set(mask.map(([r,c])=>r+','+c)));
    level.veil = { cells, required: offlineVeilRequired(shape.moves, cells, share) };
  }else if(objective === 'cascade'){
    level.cascade = { required: offlineCascadeGoal(shape.moves, shape.colors, share) };
    level.target = Math.round(target*0.6);
  }else if(objective === 'timed'){
    level.target = Math.round(target*TIMED_TARGET_RELIEF/10)*10;
    level.timedSeconds = timedSecondsFor(shape.moves);
  }

  if(twists.length){
    applyTwists(level, shape, twists, mask, rng);
    refitOfflineGoal(level, objective, share, ease);
  }
  if(isFinale){
    const chapter = Math.floor(index/CHAPTER_SIZE) + 1;
    const slot = slotInChapter - (CHAPTER_SIZE - CHAPTER_TAIL);
    // Endless finales draw through the stable hash so they match the server
    // exactly; below the endless range they keep the old mulberry32 draw,
    // because those finales' modifiers are part of levels players have
    // already cleared. See _finale_modifiers() in level_gen.py.
    const tag = `finale::${mode}::${chapter}::${slot}`;
    const modRng = mulberry32(hashSeed(tag));
    const mods = eraPos
      ? { piece: stablePick(`piece::${tag}`, FINALE_PIECES),
          task: stablePick(`task::${tag}`, FINALE_TASKS),
          skin: stablePick(`skin::${tag}`, FINALE_SKINS),
          constraint: stablePick(`constraint::${tag}`, FINALE_CONSTRAINTS) }
      : { piece:pickFrom(FINALE_PIECES,modRng), task:pickFrom(FINALE_TASKS,modRng),
          skin:pickFrom(FINALE_SKINS,modRng), constraint:pickFrom(FINALE_CONSTRAINTS,modRng) };
    applyFinale(level, shape, mods, rng, symbolCap, objective);
    // A finale tightens moves, widens the palette and can layer extra veils
    // on, so the goal is recalibrated on the board the finale actually ships
    // — same reason as get_level() in server/app/level_gen.py.
    refitOfflineGoal(level, objective, share, ease);
  }
  delete level.raisedTargetBy;
  return level;
}

// Re-read a level's goal off the board it actually ships. Shared by the
// finale path and the endless-twist path, both of which can change the move
// budget or the palette after the goal was first set.
function refitOfflineGoal(level, objective, share, ease){
  if(objective === 'collect' && level.collect){
    const goal = offlineCollectGoal(level.moves, level.colors, share);
    const jitter = Math.round(goal * 0.08);
    level.collect = level.collect.map((req,i)=>({
      type: req.type,
      count: Math.max(3, goal + ((i % 3) - 1) * jitter),
    }));
  }else if(objective === 'veil' && level.veil){
    level.veil.required = offlineVeilRequired(level.moves, level.veil.cells, share);
  }else if(objective === 'cascade' && level.cascade){
    level.cascade.required = offlineCascadeGoal(level.moves, level.colors, share);
  }else if(objective === 'score' || objective === 'timed'){
    // A twist or a finale that tightens the move budget or widens the palette
    // moves the reachable score too, and a score target left at the old
    // board's figure is the same unwinnable level by another route.
    const fitted = offlineScoreTarget(level.rows, level.cols, level.colors,
                                      level.moves, level.mask ? level.mask.length : 0,
                                      ease, level.raisedTargetBy ? ENDLESS_RAISED_TARGET_SHIFT : 0);
    level.target = objective === 'timed'
      ? Math.max(OFFLINE_SCORE_MIN, Math.round(fitted*TIMED_TARGET_RELIEF/10)*10)
      : fitted;
  }
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
  // Same offline target approximation as localFallbackLevel — see its
  // comment: no simulated playouts client-side, so approximate the shape
  // the server would calibrate to, from board size/move budget directly.
  const target = offlineScoreTarget(shape.rows, shape.cols, shape.colors,
                                    shape.moves, 0, DAILY_EASE);
  const names = ['A Gentle Start','Rising Faith','Steady Hands','Widening Path','Deeper Waters',
    "Refiner's Fire",'Mountain Climb','Radiant Crown','Quiet Trust','Open Doors','Living Water','New Mercies'];
  return {
    mode:'daily-blessing', index:0, name: names[Math.floor(rng()*names.length)],
    rows: shape.rows, cols: shape.cols, colors: shape.colors, moves: shape.moves,
    objective:'score', target, collect:null, veil:null,
    difficultyRating: Math.min(1, 0.35*(shape.rows*shape.cols)/81 + 0.30*shape.colors/SYMBOL_COUNT + 0.35*(1-Math.min(1,shape.moves/24))),
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
  ERA_RELIC_LOOKUP,
  // Exported for server/tools/dump_offline_levels.mjs, which feeds these
  // levels to the simulator so the offline goals are held to the same
  // "no unwinnable level" bar as the calibrated ones.
  localFallbackLevel,
};
