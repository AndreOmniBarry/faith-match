/* ============================= MATCH ENGINE ============================= */
// Grid state, match detection (including L/T-shaped intersections), special
// tile creation, the special-combo pairing table (striped/wrapped/color-bomb
// pairs), the veil obstacle mechanic (Refiner's Fire), collect-objective
// tallying, and the cascade resolve loop. Talks to render.js for DOM/motion and effects.js /
// audio.js for the "chaos" — this module is the rules, not the pixels.

import * as render from './render.js';
import * as effects from './effects.js';
import * as audio from './audio.js';
import { SYMBOLS } from './content.js';

const SWAP_MS = 200;
const POP_MS = 190;
const FALL_MS = 300;

let rows = 8, cols = 8, colorCount = 6;
let grid = [];
let veilGrid = [];
let tilesById = new Map();
let nextId = 1;
let level = null;
let score = 0, movesLeft = 0, movesUsed = 0, comboStep = 0;
let collectProgress = {};
let veilTotal = 0;
let busy = false;
let swapAnchorCells = null;
let callbacks = {};
let comboMeter = 0;
const COMBO_METER_CAP = 100;
let wildcardUsed = false, shrinkTriggered = false;

const sleep = (ms)=>new Promise(res=>setTimeout(res,ms));
const rand = (n)=>Math.floor(Math.random()*n);

function setCallbacks(cb){ callbacks = cb || {}; }
function isBusy(){ return busy; }

/* ============================= GRID HELPERS ============================= */

function typeAt(r,c){
  if(r<0||r>=rows||c<0||c>=cols) return -1;
  if(veilGrid[r][c] > 0) return -1; // veiled cells are invisible to matching until freed
  const id = grid[r][c];
  if(id==null) return -1;
  return tilesById.get(id).type;
}
function isSwappable(r,c){
  if(r<0||r>=rows||c<0||c>=cols) return false;
  return veilGrid[r][c] === 0;
}
function isAdjacent(a,b){
  const dr = Math.abs(a.r-b.r), dc = Math.abs(a.c-b.c);
  return (dr+dc)===1;
}

function checkLine(get,r,c){
  const t = get(r,c);
  if(t<0) return false;
  let run=1, cc=c-1;
  while(cc>=0 && get(r,cc)===t){run++;cc--;}
  cc=c+1;
  while(cc<cols && get(r,cc)===t){run++;cc++;}
  if(run>=3) return true;
  run=1; let rr=r-1;
  while(rr>=0 && get(rr,c)===t){run++;rr--;}
  rr=r+1;
  while(rr<rows && get(rr,c)===t){run++;rr++;}
  return run>=3;
}
function wouldMatch(r1,c1,r2,c2){
  const t1 = typeAt(r1,c1), t2 = typeAt(r2,c2);
  if(t1===t2 || t1<0 || t2<0) return false;
  const get = (r,c)=> (r===r1&&c===c1) ? t2 : (r===r2&&c===c2) ? t1 : typeAt(r,c);
  return checkLine(get,r1,c1) || checkLine(get,r2,c2);
}
function hasPossibleMove(){
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      if(c+1<cols && wouldMatch(r,c,r,c+1)) return true;
      if(r+1<rows && wouldMatch(r,c,r+1,c)) return true;
    }
  }
  return false;
}
function swapPotential(r1,c1,r2,c2){
  // How good is this move? Simulate it and measure the longer resulting run
  // at each touched cell — cheap on a <=9x9 board, and enough to rank moves
  // without a full cascade simulation.
  const t1 = typeAt(r1,c1), t2 = typeAt(r2,c2);
  const get = (r,c)=> (r===r1&&c===c1) ? t2 : (r===r2&&c===c2) ? t1 : typeAt(r,c);
  const runAt = (r,c)=>{
    const t = get(r,c); if(t<0) return 0;
    let run=1, cc=c-1; while(cc>=0 && get(r,cc)===t){run++;cc--;}
    cc=c+1; while(cc<cols && get(r,cc)===t){run++;cc++;}
    let best=run;
    run=1; let rr=r-1; while(rr>=0 && get(rr,c)===t){run++;rr--;}
    rr=r+1; while(rr<rows && get(rr,c)===t){run++;rr++;}
    return Math.max(best,run);
  };
  return runAt(r1,c1) + runAt(r2,c2);
}
function findValidSwapHint(){
  // Best move, with a little randomness around it — always hinting the
  // literal optimal swap would make the hint predictable/roboticfeeling;
  // ranking then picking among the top few keeps it feeling alive.
  const candidates = [];
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      if(c+1<cols && wouldMatch(r,c,r,c+1)) candidates.push({ a:{r,c}, b:{r,c:c+1}, score:swapPotential(r,c,r,c+1) });
      if(r+1<rows && wouldMatch(r,c,r+1,c)) candidates.push({ a:{r,c}, b:{r:r+1,c}, score:swapPotential(r,c,r+1,c) });
    }
  }
  if(!candidates.length) return null;
  candidates.sort((x,y)=>y.score-x.score);
  const pool = candidates.slice(0, Math.min(3, candidates.length));
  const pick = pool[rand(pool.length)];
  return [pick.a, pick.b];
}

/* ============================= BOARD GENERATION ============================= */

function buildInitialBoard(lvl){
  rows = lvl.rows; cols = lvl.cols; colorCount = lvl.colors;
  let attempts = 0;
  do{
    grid = Array.from({length:rows}, ()=>Array(cols).fill(null));
    veilGrid = Array.from({length:rows}, ()=>Array(cols).fill(0));
    tilesById.clear();
    nextId = 1;
    for(let r=0;r<rows;r++){
      for(let c=0;c<cols;c++){
        let type, tries=0;
        do{
          type = rand(colorCount);
          tries++;
        }while(
          tries < 30 && (
            (c>=2 && typeAt(r,c-1)===type && typeAt(r,c-2)===type) ||
            (r>=2 && typeAt(r-1,c)===type && typeAt(r-2,c)===type)
          )
        );
        const id = nextId++;
        tilesById.set(id, { id, r, c, type, special:null, veil:0, el:null });
        grid[r][c] = id;
      }
    }
    // Veils aren't exclusive to Refiner's Fire: a finale's "Locked Chain"
    // modifier layers a few onto any objective as an extra constraint —
    // only the 'veil' objective actually requires clearing them to win.
    if(lvl.veil && lvl.veil.cells){
      lvl.veil.cells.forEach(([r,c,layers])=>{
        if(r<rows && c<cols && grid[r][c]!=null){
          veilGrid[r][c] = layers;
          tilesById.get(grid[r][c]).veil = layers;
        }
      });
    }
    attempts++;
  }while(!hasPossibleMove() && attempts < 14);
}

/* ============================= MATCH DETECTION ============================= */

function findMatches(){
  const runs = [];
  for(let r=0;r<rows;r++){
    let c=0;
    while(c<cols){
      const t = typeAt(r,c);
      if(t<0){ c++; continue; }
      let c2=c+1;
      while(c2<cols && typeAt(r,c2)===t) c2++;
      const len = c2-c;
      if(len>=3){
        const cells=[]; for(let k=c;k<c2;k++) cells.push([r,k]);
        runs.push({dir:'h', length:len, cells});
      }
      c=c2;
    }
  }
  for(let c=0;c<cols;c++){
    let r=0;
    while(r<rows){
      const t = typeAt(r,c);
      if(t<0){ r++; continue; }
      let r2=r+1;
      while(r2<rows && typeAt(r2,c)===t) r2++;
      const len = r2-r;
      if(len>=3){
        const cells=[]; for(let k=r;k<r2;k++) cells.push([k,c]);
        runs.push({dir:'v', length:len, cells});
      }
      r=r2;
    }
  }
  return runs;
}

function pickAnchor(run, preferred){
  const candidates = run.cells.filter(([r,c])=>{
    const id = grid[r][c];
    const t = id!=null ? tilesById.get(id) : null;
    return !(t && t.special);
  });
  const pool = candidates.length ? candidates : run.cells;
  if(preferred){
    for(const pc of preferred){
      const hit = pool.find(([r,c])=>r===pc[0]&&c===pc[1]);
      if(hit) return hit;
    }
  }
  return pool[Math.floor(pool.length/2)];
}

// Priority: 5+-in-a-row -> Color Bomb, L/T intersection -> Wrapped, 4-in-a-row -> Striped.
function decideCreations(runs){
  const used = new Set();
  const creations = [];

  runs.map((r,i)=>i).sort((a,b)=>runs[b].length-runs[a].length).forEach(i=>{
    if(used.has(i)) return;
    if(runs[i].length>=5){
      const anchor = pickAnchor(runs[i], swapAnchorCells);
      creations.push({ r:anchor[0], c:anchor[1], special:{kind:'colorbomb'} });
      used.add(i);
    }
  });

  for(let i=0;i<runs.length;i++){
    if(used.has(i) || runs[i].length<3) continue;
    for(let j=i+1;j<runs.length;j++){
      if(used.has(j) || runs[j].length<3 || runs[i].dir===runs[j].dir) continue;
      const shared = runs[i].cells.find(([r,c])=>runs[j].cells.some(([r2,c2])=>r2===r&&c2===c));
      if(shared){
        creations.push({ r:shared[0], c:shared[1], special:{kind:'wrapped'} });
        used.add(i); used.add(j);
        break;
      }
    }
  }

  runs.forEach((run,i)=>{
    if(used.has(i)) return;
    if(run.length>=4){
      const anchor = pickAnchor(run, swapAnchorCells);
      creations.push({ r:anchor[0], c:anchor[1], special:{kind:'striped', dir:run.dir} });
      used.add(i);
    }
  });

  return creations;
}

function getActivationCells(tile){
  const cells = [];
  if(tile.special.kind==='striped'){
    if(tile.special.dir==='h'){ for(let c=0;c<cols;c++) cells.push([tile.r,c]); }
    else{ for(let r=0;r<rows;r++) cells.push([r,tile.c]); }
  }else if(tile.special.kind==='wrapped'){
    for(let r=tile.r-2;r<=tile.r+2;r++){
      for(let c=tile.c-2;c<=tile.c+2;c++){
        if(r>=0&&r<rows&&c>=0&&c<cols) cells.push([r,c]);
      }
    }
  }
  return cells;
}
function cellsOfType(type){
  const cells = [];
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    const id = grid[r][c];
    if(id!=null && tilesById.get(id).type===type) cells.push([r,c]);
  }
  return cells;
}
function mostCommonTypeOnBoard(){
  const counts = new Array(colorCount).fill(0);
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    const id = grid[r][c];
    if(id!=null) counts[tilesById.get(id).type]++;
  }
  let best=0; for(let i=1;i<counts.length;i++) if(counts[i]>counts[best]) best=i;
  return best;
}

function pointsForLength(len){ return 30 + (len-3)*40; }

/* ============================= VFX HELPERS ============================= */

function colorForType(type){ return SYMBOLS[type] ? SYMBOLS[type].color : '#f4d78c'; }
function tierForRun(len){ return len>=5 ? 'large' : len===4 ? 'medium' : 'small'; }

function burstAt(r,c,color,tier){
  const {x,y} = render.cellCenter(r,c);
  effects.burst(x,y,color,tier);
}
function triggerSpecialVFX(tile){
  const {x,y} = render.cellCenter(tile.r, tile.c);
  const color = colorForType(tile.type);
  if(tile.special.kind==='striped'){
    effects.burst(x,y,'#ffffff','medium');
    if(tile.special.dir==='h'){
      const a = render.cellCenter(tile.r,0), b = render.cellCenter(tile.r,cols-1);
      effects.beam(a.x,a.y,b.x,b.y,'#ffffff');
    }else{
      const a = render.cellCenter(0,tile.c), b = render.cellCenter(rows-1,tile.c);
      effects.beam(a.x,a.y,b.x,b.y,'#ffffff');
    }
  }else if(tile.special.kind==='wrapped'){
    effects.bloom(x,y,'var(--wrapped-glow)','large');
  }else if(tile.special.kind==='colorbomb'){
    effects.bloom(x,y,'var(--colorbomb-glow)','huge');
    effects.flash('var(--colorbomb-glow)', 480, 'ripple');
    effects.pulseAmbient(700);
  }
}

/* ============================= VEIL + COLLECT ============================= */

function crackAdjacentVeils(matchedSet){
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      if(veilGrid[r][c] <= 0) continue;
      const adj = [[r-1,c],[r+1,c],[r,c-1],[r,c+1]];
      if(adj.some(([ar,ac])=>matchedSet.has(ar+','+ac))){
        veilGrid[r][c]--;
        const id = grid[r][c];
        if(id!=null){
          const t = tilesById.get(id);
          t.veil = veilGrid[r][c];
          render.refreshTileVisual(t);
        }
        audio.playVeilCrack();
      }
    }
  }
}
function veilRemainingCount(){
  let n=0;
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) if(veilGrid[r][c]>0) n++;
  return n;
}

function tallyCollect(cellKeys, excludeKeys){
  if(!level || level.objective!=='collect' || !level.collect) return;
  const wanted = new Set(level.collect.map(req=>req.type));
  cellKeys.forEach(k=>{
    if(excludeKeys && excludeKeys.has(k)) return;
    const [r,c] = k.split(',').map(Number);
    const id = grid[r][c];
    if(id==null) return;
    const type = tilesById.get(id).type;
    if(wanted.has(type)) collectProgress[type] = (collectProgress[type]||0) + 1;
  });
}

/* ============================= REMOVAL / COLLAPSE ============================= */

async function clearCells(cellKeys){
  const removeIds = [];
  cellKeys.forEach(k=>{
    const [r,c] = typeof k==='string' ? k.split(',').map(Number) : k;
    const id = grid[r][c];
    if(id!=null){
      const t = tilesById.get(id);
      if(t && t.el) t.el.classList.add('pop');
      removeIds.push(id);
      grid[r][c] = null;
    }
  });
  await sleep(POP_MS);
  removeIds.forEach(id=>{
    const t = tilesById.get(id);
    if(t){ render.removeTileEl(t); tilesById.delete(id); }
  });
  collapseAndRefill();
  await sleep(FALL_MS);
}

function collapseAndRefill(){
  const landedTiles = [];
  for(let c=0;c<cols;c++){
    let writeRow = rows-1;
    for(let r=rows-1;r>=0;r--){
      const id = grid[r][c];
      if(id!=null){
        if(writeRow!==r){
          grid[writeRow][c] = id;
          grid[r][c] = null;
          const t = tilesById.get(id);
          t.r = writeRow;
          render.setTileTransform(t.el, writeRow, c);
          landedTiles.push(t);
        }
        writeRow--;
      }
    }
    let spawnOffset = 1;
    for(let r=writeRow;r>=0;r--){
      const type = rand(colorCount);
      const id = nextId++;
      const tile = { id, r, c, type, special:null, veil:0, el:null };
      tilesById.set(id, tile);
      const el = render.createTileEl(tile, onTilePointerDown);
      tile.el = el;
      render.placeTileInstant(el, r-spawnOffset, c); // starts above the board, out of view
      render.setTileTransform(el, r, c);              // tweens smoothly down into place
      grid[r][c] = id;
      landedTiles.push(tile);
      spawnOffset++;
    }
  }
  setTimeout(()=>landedTiles.forEach(t=>render.playLandAnimation(t)), FALL_MS-40);
}

function reshuffleBoard(){
  const types = [];
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) types.push(typeAt(r,c)>=0 ? typeAt(r,c) : rand(colorCount));
  let attempts=0;
  do{
    for(let i=types.length-1;i>0;i--){ const j=rand(i+1); [types[i],types[j]]=[types[j],types[i]]; }
    attempts++;
  }while(attempts<20 && !hasPossibleMove());
  let idx=0;
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      if(veilGrid[r][c]>0){ idx++; continue; } // leave veiled cells' candy untouched
      const id = grid[r][c];
      const t = tilesById.get(id);
      t.type = types[idx++];
      t.special = null;
      render.refreshTileVisual(t);
      t.el.classList.add('spawn-special');
    }
  }
}

/* ============================= RESOLVE LOOP ============================= */

async function resolveLoop(seed){
  comboStep = 0;
  let manualIds = seed && seed.singleActivation ? [seed.singleActivation.tileId] : [];
  const manualTarget = seed && seed.singleActivation ? seed.singleActivation.targetType : null;

  while(true){
    const runs = findMatches();
    const matchedSet = new Set();
    runs.forEach(run=>run.cells.forEach(([r,c])=>matchedSet.add(r+','+c)));

    const activationQueue = [...manualIds];
    const isManualPass = manualIds.length>0;
    manualIds = [];
    matchedSet.forEach(key=>{
      const [r,c] = key.split(',').map(Number);
      const id = grid[r][c];
      if(id!=null){
        const t = tilesById.get(id);
        if(t && t.special) activationQueue.push(id);
      }
    });

    const activatedIds = new Set();
    let biggestTier = null;
    while(activationQueue.length){
      const id = activationQueue.pop();
      if(activatedIds.has(id)) continue;
      const t = tilesById.get(id);
      if(!t) continue;
      activatedIds.add(id);
      matchedSet.add(t.r+','+t.c);
      let cells;
      if(t.special.kind==='colorbomb'){
        const targetType = (isManualPass && id===seed.singleActivation.tileId && manualTarget!=null) ? manualTarget : mostCommonTypeOnBoard();
        cells = cellsOfType(targetType);
        biggestTier = 'colorbomb';
      }else{
        cells = getActivationCells(t);
        if(biggestTier!=='colorbomb') biggestTier = t.special.kind;
      }
      cells.forEach(([r,c])=>{
        matchedSet.add(r+','+c);
        const eid = grid[r][c];
        if(eid!=null && eid!==id){
          const et = tilesById.get(eid);
          if(et && et.special && !activatedIds.has(eid)) activationQueue.push(eid);
        }
      });
      triggerSpecialVFX(t);
    }

    if(matchedSet.size===0) break;
    if(activatedIds.size>0){ audio.playSpecialSound(biggestTier); }

    crackAdjacentVeils(matchedSet);

    const creations = decideCreations(runs);

    // Finale-only "Wildcard Blessing" modifier: once per level, even a plain
    // match gets upgraded into a bonus Color Bomb — a surprise treat rather
    // than a new match-detection rule, so it can't destabilize core matching.
    if(level.finalePiece==='wildcard' && !wildcardUsed && runs.length>0 &&
       creations.every(cr=>cr.special.kind!=='colorbomb')){
      const anchor = pickAnchor(runs[0], swapAnchorCells);
      creations.push({ r:anchor[0], c:anchor[1], special:{kind:'colorbomb'} });
      wildcardUsed = true;
      callbacks.onToast && callbacks.onToast('A Wildcard Blessing! ✨');
    }

    const creationKeys = new Set(creations.map(cr=>cr.r+','+cr.c));

    tallyCollect(matchedSet, creationKeys);

    let roundPoints = 0;
    runs.forEach(run=>roundPoints += pointsForLength(run.length));
    const runCells = new Set();
    runs.forEach(run=>run.cells.forEach(([r,c])=>runCells.add(r+','+c)));
    const bonusCells = [...matchedSet].filter(k=>!runCells.has(k));
    roundPoints += bonusCells.length*15;
    const multiplier = (1 + 0.4*comboStep) * (level.bonusMultiplier||1);
    score += Math.round(roundPoints*multiplier);

    if(comboStep>=1) effects.comboPopup(comboStep+1);
    const soundType = runs.length ? typeAt(runs[0].cells[0][0], runs[0].cells[0][1]) : null;
    audio.playMatchSound(comboStep, soundType!=null && soundType>=0 ? soundType : undefined);

    runs.forEach(run=>{
      const [r,c] = run.cells[Math.floor(run.cells.length/2)];
      burstAt(r,c, colorForType(typeAt(r,c)>=0?typeAt(r,c):0), tierForRun(run.length));
    });
    const shakeMag = 2 + comboStep*1.6 + (activatedIds.size?5:0) + (matchedSet.size>=12?4:0);
    if(shakeMag>3) effects.shake(Math.min(16,shakeMag), 240 + Math.min(160,matchedSet.size*8));
    if(shakeMag>7) effects.pulseAmbient(600);

    comboMeter = Math.min(COMBO_METER_CAP, comboMeter + 12 + (activatedIds.size?25:0));
    notifyHUD();
    comboStep++;

    creations.forEach(cr=>{
      const id = grid[cr.r][cr.c];
      if(id!=null){
        const t = tilesById.get(id);
        if(t && !t.special){
          t.special = cr.special;
          render.refreshTileVisual(t);
          t.el.classList.add('spawn-special');
        }
      }
    });

    const toRemove = [...matchedSet].filter(k=>!creationKeys.has(k));
    await clearCells(toRemove);
  }

  if(!hasPossibleMove()){
    await sleep(250);
    callbacks.onToast && callbacks.onToast('The board is renewed…');
    reshuffleBoard();
    await sleep(400);
  }
}

/* ============================= COMBO PAIRING ============================= */

async function resolveComboPair(tA, tB){
  const pivot = { r:tA.r, c:tA.c };
  const kindA = tA.special.kind, kindB = tB.special.kind;
  const cells = new Set([`${tA.r},${tA.c}`, `${tB.r},${tB.c}`]);
  let vfxColor = 'var(--gold-soft)';
  let bonus = 0;

  const addRow = (r)=>{ for(let c=0;c<cols;c++) cells.add(`${r},${c}`); };
  const addCol = (c)=>{ for(let r=0;r<rows;r++) cells.add(`${r},${c}`); };

  if(kindA==='striped' && kindB==='striped'){
    addRow(pivot.r); addCol(pivot.c); bonus=600;
  }else if((kindA==='striped'&&kindB==='wrapped')||(kindA==='wrapped'&&kindB==='striped')){
    for(let dr=-1;dr<=1;dr++){ const r=pivot.r+dr; if(r>=0&&r<rows) addRow(r); }
    for(let dc=-1;dc<=1;dc++){ const c=pivot.c+dc; if(c>=0&&c<cols) addCol(c); }
    bonus=900; vfxColor='var(--wrapped-glow)';
  }else if(kindA==='wrapped' && kindB==='wrapped'){
    for(let dr=-2;dr<=2;dr++) for(let dc=-2;dc<=2;dc++){
      const r=pivot.r+dr, c=pivot.c+dc;
      if(r>=0&&r<rows&&c>=0&&c<cols) cells.add(`${r},${c}`);
    }
    bonus=1400; vfxColor='var(--wrapped-glow)';
  }else if(kindA==='colorbomb' && kindB==='colorbomb'){
    for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) cells.add(`${r},${c}`);
    bonus=2000; vfxColor='var(--colorbomb-glow)';
  }else{
    const bombIsA = kindA==='colorbomb';
    const partner = bombIsA ? tB : tA;
    const targetType = partner.type;
    for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
      const id = grid[r][c];
      if(id==null) continue;
      const t = tilesById.get(id);
      if(t.type!==targetType) continue;
      cells.add(`${r},${c}`);
      const fake = { r, c, special: partner.special.kind==='striped'
        ? { kind:'striped', dir: Math.random()<0.5?'h':'v' }
        : { kind:'wrapped' } };
      getActivationCells(fake).forEach(([rr,cc])=>cells.add(`${rr},${cc}`));
    }
    bonus = 1200 + cells.size*15;
    vfxColor = 'var(--colorbomb-glow)';
  }

  score += Math.round(bonus * (level.bonusMultiplier||1));
  comboMeter = Math.min(COMBO_METER_CAP, comboMeter + 40);
  const {x,y} = render.cellCenter(pivot.r, pivot.c);
  effects.flash(vfxColor, 520, 'ripple');
  effects.shake(16, 380);
  effects.pulseAmbient(900);
  effects.bloom(x,y,vfxColor,'huge');
  audio.playSpecialSound('combo');
  effects.comboPopup(2);

  crackAdjacentVeils(cells);
  tallyCollect(cells, new Set());
  notifyHUD();

  await clearCells([...cells]);
  await resolveLoop({});
}

function maybeTriggerShrink(){
  if(shrinkTriggered || !level.shrinkCells || !level.shrinkCells.length) return;
  if(movesUsed < Math.floor(level.moves/2)) return;
  shrinkTriggered = true;
  level.shrinkCells.forEach(([r,c])=>{
    if(r<rows && c<cols && grid[r][c]!=null){
      veilGrid[r][c] = (veilGrid[r][c]||0) + 1;
      const t = tilesById.get(grid[r][c]);
      t.veil = veilGrid[r][c];
      render.refreshTileVisual(t);
    }
  });
  callbacks.onToast && callbacks.onToast('The shrinking pieces have locked in tighter!');
  audio.playVeilCrack();
}
function spendMove(){
  movesLeft--; movesUsed++;
  maybeTriggerShrink();
  notifyHUD();
}

/* ============================= SWAP / INPUT ============================= */

let onTilePointerDown = null;
function setPointerHandler(fn){ onTilePointerDown = fn; }

async function attemptSwap(a,b){
  if(busy) return;
  if(!isSwappable(a.r,a.c) || !isSwappable(b.r,b.c)){
    const idA = grid[a.r][a.c], idB = grid[b.r][b.c];
    [idA,idB].forEach(id=>{
      const t = id!=null && tilesById.get(id);
      if(t && t.el){ t.el.classList.add('shake'); setTimeout(()=>t.el && t.el.classList.remove('shake'),300); }
    });
    audio.playSwapFail();
    callbacks.onToast && callbacks.onToast('That one is still veiled — free it from beside.');
    return;
  }

  busy = true;
  const idA = grid[a.r][a.c], idB = grid[b.r][b.c];
  const tA = tilesById.get(idA), tB = tilesById.get(idB);

  const fromA = render.cellCenter(a.r,a.c), toA = render.cellCenter(b.r,b.c);
  const fromB = render.cellCenter(b.r,b.c), toB = render.cellCenter(a.r,a.c);
  grid[a.r][a.c] = idB; grid[b.r][b.c] = idA;
  tA.r=b.r; tA.c=b.c; tB.r=a.r; tB.c=a.c;
  render.setTileTransform(tA.el, tA.r, tA.c);
  render.setTileTransform(tB.el, tB.r, tB.c);
  render.playSwapStretch(tA); render.playSwapStretch(tB);
  effects.trail(fromA.x,fromA.y,toA.x,toA.y, colorForType(tA.type));
  effects.trail(fromB.x,fromB.y,toB.x,toB.y, colorForType(tB.type));
  await sleep(SWAP_MS);

  const specialA = tA.special, specialB = tB.special;

  if(specialA && specialB){
    spendMove();
    await resolveComboPair(tA, tB);
    checkEndConditions();
    return;
  }
  if(specialA && !specialB){
    spendMove();
    await resolveLoop({ singleActivation:{ tileId:tA.id, targetType:tB.type } });
    checkEndConditions();
    return;
  }
  if(specialB && !specialA){
    spendMove();
    await resolveLoop({ singleActivation:{ tileId:tB.id, targetType:tA.type } });
    checkEndConditions();
    return;
  }

  const runs = findMatches();
  if(runs.length>0){
    spendMove();
    swapAnchorCells = [[b.r,b.c],[a.r,a.c]];
    await resolveLoop({});
    swapAnchorCells = null;
    checkEndConditions();
  }else{
    audio.playSwapFail();
    grid[a.r][a.c] = idA; grid[b.r][b.c] = idB;
    tA.r=a.r; tA.c=a.c; tB.r=b.r; tB.c=b.c;
    tA.el.classList.add('shake'); tB.el.classList.add('shake');
    render.setTileTransform(tA.el, tA.r, tA.c);
    render.setTileTransform(tB.el, tB.r, tB.c);
    await sleep(SWAP_MS);
    tA.el.classList.remove('shake'); tB.el.classList.remove('shake');
    busy = false;
  }
}

/* ============================= SESSION / HUD ============================= */

function notifyHUD(){ callbacks.onHUD && callbacks.onHUD(getSessionState()); }

function getSessionState(){
  const state = {
    score, movesLeft: Math.max(movesLeft,0), comboStep,
    objective: level.objective, target: level.target,
    comboMeter, comboMeterCap: COMBO_METER_CAP,
  };
  if(level.objective==='collect'){
    state.collect = level.collect.map(req=>({ type:req.type, count:req.count, collected: Math.min(req.count, collectProgress[req.type]||0) }));
  }
  if(level.objective==='veil'){
    state.veilTotal = veilTotal;
    state.veilRemaining = veilRemainingCount();
  }
  return state;
}

function checkEndConditions(){
  let won = false;
  if(level.objective==='score'){ won = score >= level.target; }
  else if(level.objective==='collect'){ won = level.collect.every(req => (collectProgress[req.type]||0) >= req.count); }
  else if(level.objective==='veil'){ won = veilRemainingCount()===0; }

  if(won){
    setTimeout(()=>callbacks.onWin && callbacks.onWin(getSessionState()), 350);
  }else if(movesLeft<=0){
    // busy stays true here on purpose — screens.js may offer a paid
    // "continue" before the level is actually over; addMoves()/forceLose()
    // are what release it.
    setTimeout(()=>{
      if(callbacks.onOutOfMoves) callbacks.onOutOfMoves(getSessionState());
      else if(callbacks.onLose) callbacks.onLose(getSessionState());
    }, 350);
  }else{
    busy = false;
  }
}

function addMoves(n){
  movesLeft += n;
  busy = false;
  notifyHUD();
}
function forceLose(){
  callbacks.onLose && callbacks.onLose(getSessionState());
}

/* ============================= COMBO METER + ITEMS ============================= */

function getComboMeter(){ return comboMeter; }

// Every branch below both raises the score AND tells the player exactly
// what they got — a Surge should never read as "nothing happened". The
// flavor differs (moves vs. a gifted special vs. a board-clearing blast),
// but the score line and the toast are guaranteed every single time.
const SURGE_BASE_BONUS = 120;

async function popComboMeter(){
  if(comboMeter < COMBO_METER_CAP) return false;
  // The meter shows "ready" the instant it hits the cap, but a cascade
  // from the match that filled it can still be resolving (busy=true) for
  // a few hundred ms after. A tap that lands in that window used to be
  // silently dropped — the meter would sit there full and dead until the
  // *next* match happened to catch it "not busy", which read as "does
  // nothing" more often than not. Wait for the board to settle instead of
  // discarding the tap.
  for(let waited=0; busy && waited<1500; waited+=60) await sleep(60);
  if(comboMeter < COMBO_METER_CAP || busy) return false; // still busy, or something else drained it meanwhile
  comboMeter = 0;
  busy = true;
  notifyHUD();
  audio.playSurgeSting();
  effects.comboPopup(3);
  const effect = ['hammerRandom','bonusMoves','freeColorBomb','scoreBurst'][rand(4)];

  if(effect==='bonusMoves'){
    movesLeft += 2;
    score += SURGE_BASE_BONUS;
    effects.flash('var(--gold-soft)', 400);
    callbacks.onToast && callbacks.onToast(`Surge! +2 Moves and +${SURGE_BASE_BONUS} ✨`);
  }else if(effect==='scoreBurst'){
    score += 300;
    const {x,y} = render.cellCenter((rows/2)|0, (cols/2)|0);
    effects.flash('var(--gold-soft)', 400);
    effects.burst(x,y,'var(--gold-soft)','huge');
    callbacks.onToast && callbacks.onToast('Surge! +300 ✨');
  }else if(effect==='freeColorBomb'){
    score += SURGE_BASE_BONUS;
    spawnFreeColorBomb();
    callbacks.onToast && callbacks.onToast(`Surge! Free Color Bomb gifted, +${SURGE_BASE_BONUS} ✨`);
  }else{
    const cr = rand(rows), cc = rand(cols);
    const cells = [];
    for(let r=cr-1;r<=cr+1;r++) for(let c=cc-1;c<=cc+1;c++){
      if(r>=0&&r<rows&&c>=0&&c<cols) cells.push([r,c]);
    }
    const {x,y} = render.cellCenter(cr,cc);
    effects.bloom(x,y,'var(--wrapped-glow)','huge');
    effects.shake(14,300);
    effects.pulseAmbient(700);
    const keys = cells.map(([r,c])=>r+','+c);
    crackAdjacentVeils(new Set(keys));
    tallyCollect(keys, new Set());
    const gained = cells.length*20;
    score += gained;
    cells.forEach(([r,c])=>{ veilGrid[r][c] = 0; }); // the surge bypasses locks in its blast radius
    await clearCells(cells);
    await resolveLoop({});
    callbacks.onToast && callbacks.onToast(`Surge! +${gained} ✨`);
  }

  notifyHUD();
  checkEndConditions();
  return true;
}

function spawnFreeColorBomb(){
  const candidates = [];
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    const id = grid[r][c];
    if(id!=null && veilGrid[r][c]===0){
      const t = tilesById.get(id);
      if(!t.special) candidates.push(t);
    }
  }
  if(!candidates.length) return false;
  const t = candidates[rand(candidates.length)];
  t.special = { kind:'colorbomb' };
  render.refreshTileVisual(t);
  t.el.classList.add('spawn-special');
  triggerSpecialVFX(t);
  return true;
}

// Inventory item effects — all bypass the move counter (that's what makes
// them premium) and are no-ops while a resolve is already in flight.
async function useHammer(r,c){
  if(busy) return false;
  busy = true;
  const key = r+','+c;
  const {x,y} = render.cellCenter(r,c);
  effects.burst(x,y,'var(--wrapped-glow)','large');
  effects.shake(10,220);
  audio.playSpecialSound('wrapped');
  veilGrid[r][c] = 0; // the hammer obliterates any lock instantly
  crackAdjacentVeils(new Set([key]));
  tallyCollect([key], new Set());
  score += 50;
  await clearCells([[r,c]]);
  await resolveLoop({});
  notifyHUD();
  checkEndConditions();
  return true;
}
function useRainbowShuffle(){
  if(busy) return false;
  reshuffleBoard();
  effects.flash('var(--gold-soft)',400);
  audio.playSpecialSound('striped');
  notifyHUD();
  return true;
}
function useColorBombGift(){
  if(busy) return false;
  const ok = spawnFreeColorBomb();
  if(ok) audio.playSpecialSound('colorbomb');
  return ok;
}

function starsFor(finalScore, target){
  if(finalScore >= target*1.6) return 3;
  if(finalScore >= target*1.25) return 2;
  if(finalScore >= target) return 1;
  return 0;
}

/* ============================= PUBLIC: LEVEL LIFECYCLE ============================= */

async function startLevel(lvl, boardEl){
  level = lvl;
  score = 0; comboStep = 0; busy = false; swapAnchorCells = null;
  movesLeft = lvl.moves; movesUsed = 0;
  collectProgress = {};
  comboMeter = 0; wildcardUsed = false; shrinkTriggered = false;

  render.setBoardEl(boardEl);
  await render.getReady(); // WebGL init + procedural tile textures are async on first use
  buildInitialBoard(lvl);
  veilTotal = veilRemainingCount();
  render.renderFullBoard(rows, cols, grid, tilesById, (e)=>onTilePointerDown && onTilePointerDown(e));
  notifyHUD();
}

function resizeBoard(){
  if(!render.getBoardEl()) return;
  render.measureTileSize(cols);
  tilesById.forEach(t=>{ if(t.el) render.resizeTile(t.el, t.r, t.c); });
}

function getIdleVisualTargets(){
  const tileEls = []; tilesById.forEach(t=>{ if(t.el) tileEls.push(t.el); });
  const hint = findValidSwapHint();
  let hintEls = null;
  if(hint){
    const [a,b] = hint;
    const ida = grid[a.r][a.c], idb = grid[b.r][b.c];
    hintEls = [ida && tilesById.get(ida).el, idb && tilesById.get(idb).el];
  }
  return { tileEls, hintEls };
}

function getTileElAt(r,c){
  const id = grid[r] ? grid[r][c] : null;
  if(id==null) return null;
  const t = tilesById.get(id);
  return t ? t.el : null;
}

export {
  setCallbacks, setPointerHandler, isBusy,
  startLevel, attemptSwap, resizeBoard,
  getSessionState, checkEndConditions, starsFor,
  isAdjacent, getIdleVisualTargets, getTileElAt,
  addMoves, forceLose,
  getComboMeter, popComboMeter,
  useHammer, useRainbowShuffle, useColorBombGift,
};
