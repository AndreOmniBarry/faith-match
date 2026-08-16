/* ============================= AUDIO ============================= */
// Real playback, built around files you drop into assets/audio/ — see
// assets/audio/README.md for the exact filenames each slot looks for.
// Every slot degrades to silence if its file isn't present yet (checked
// once via a lightweight probe, never a thrown/console error), so this
// works today with zero files and picks up each track/effect the moment
// it's added, with no code change needed.

const MUSIC_DIR = 'assets/audio/music/';
const SFX_DIR = 'assets/audio/sfx/';
const EXTS = ['mp3', 'ogg'];

let soundOn = true;
let unlocked = false; // browsers block audio until a user gesture

// name -> HTMLAudioElement | null (null = probed, not found)
const musicCache = new Map();
const sfxCache = new Map();
let currentMusic = null; // { key, el }

function probe(baseUrl, onReady){
  // Try each extension in turn; resolve to a ready <audio> element, or
  // null if none of them exist. Never throws, never logs — a missing
  // asset is an expected, silent state, not an error.
  let i = 0;
  const tryNext = () => {
    if(i >= EXTS.length){ onReady(null); return; }
    const url = `${baseUrl}.${EXTS[i++]}`;
    const el = new Audio();
    el.preload = 'auto';
    const cleanup = () => { el.oncanplaythrough = null; el.onerror = null; };
    el.oncanplaythrough = () => { cleanup(); onReady(el); };
    el.onerror = () => { cleanup(); tryNext(); };
    el.src = url;
  };
  tryNext();
}

function getMusic(key, cb){
  if(musicCache.has(key)){ cb(musicCache.get(key)); return; }
  probe(MUSIC_DIR + key, (el) => { musicCache.set(key, el); cb(el); });
}

function getSfx(key, cb){
  if(sfxCache.has(key)){ cb(sfxCache.get(key)); return; }
  probe(SFX_DIR + key, (el) => { sfxCache.set(key, el); cb(el); });
}

function setSoundEnabled(v){
  soundOn = v;
  if(!v && currentMusic) currentMusic.el.pause();
  else if(v && currentMusic) currentMusic.el.play().catch(()=>{});
}
function isSoundEnabled(){ return soundOn; }

function ensureAudio(){
  // Call from a real user-gesture handler (first tap) — some browsers
  // (iOS Safari in particular) refuse to play any audio, even muted,
  // until playback has been kicked off inside a click/tap event.
  if(unlocked) return;
  unlocked = true;
  const silence = new Audio();
  silence.play().catch(()=>{});
}

function playSfx(key, { volume = 0.55 } = {}){
  if(!soundOn) return;
  getSfx(key, (el) => {
    if(!el) return;
    // Clone so overlapping triggers (rapid matches/cascades) don't cut
    // each other off — cheap, and these clips are always short.
    const node = el.cloneNode();
    node.volume = volume;
    node.play().catch(()=>{});
  });
}

function playMatchSound(){ playSfx('pop', { volume: 0.5 }); }
function playSpecialSound(){ playSfx('special', { volume: 0.65 }); }
function playSwapFail(){ playSfx('swap-fail', { volume: 0.45 }); }
function playVeilCrack(){ playSfx('crack', { volume: 0.6 }); }
function playWinSound(){ playSfx('win', { volume: 0.8 }); }
function playLoseSound(){ playSfx('lose', { volume: 0.7 }); }
function playSurgeSting(){ playSfx('surge', { volume: 0.7 }); }
function playFinaleSting(){ playSfx('finale', { volume: 0.7 }); }
function playGateSting(){ playSfx('gate', { volume: 0.65 }); }
function playStreakSting(){ playSfx('streak', { volume: 0.7 }); }
function playUiTap(){ playSfx('tap', { volume: 0.35 }); }
function playScreenIn(){ playSfx('screen-in', { volume: 0.4 }); }
function playScreenBack(){ playSfx('screen-back', { volume: 0.4 }); }

function fadeTo(el, target, ms, onDone){
  const start = el.volume, t0 = performance.now();
  function step(t){
    // requestAnimationFrame's timestamp can, rarely, land fractionally
    // before the performance.now() captured just before scheduling it —
    // clamp both ends, and clamp the final value too as a second line of
    // defense, since HTMLMediaElement.volume throws (not just clips) on
    // anything outside [0,1].
    const p = Math.max(0, Math.min(1, (t - t0) / ms));
    el.volume = Math.max(0, Math.min(1, start + (target - start) * p));
    if(p < 1) requestAnimationFrame(step);
    else onDone && onDone();
  }
  requestAnimationFrame(step);
}

function switchMusic(key, { volume = 0.35, fadeMs = 600 } = {}){
  if(currentMusic && currentMusic.key === key) return;
  const prev = currentMusic;
  currentMusic = null;
  if(prev){
    fadeTo(prev.el, 0, fadeMs, () => { prev.el.pause(); prev.el.currentTime = 0; });
  }
  if(!soundOn) return;
  getMusic(key, (el) => {
    if(!el) return;
    el.loop = true;
    el.volume = 0;
    currentMusic = { key, el };
    el.play().catch(()=>{});
    fadeTo(el, volume, fadeMs);
  });
}

// mode: pass the current mode id (e.g. 'harvest') to prefer a per-mode
// theme file (theme-<mode>.mp3) if present, else fall back to the
// shared gameplay loop (theme-gameplay.mp3).
function startAmbientPad(mode){
  if(mode){
    getMusic(`theme-${mode}`, (el) => {
      switchMusic(el ? `theme-${mode}` : 'theme-gameplay');
    });
  } else {
    switchMusic('theme-gameplay');
  }
}
function stopAmbientPad(){
  if(!currentMusic) return;
  const prev = currentMusic;
  currentMusic = null;
  fadeTo(prev.el, 0, 500, () => { prev.el.pause(); prev.el.currentTime = 0; });
}
function playMenuTheme(){ switchMusic('theme-main', { volume: 0.3 }); }

function vibrate(pattern){ try{ if(navigator.vibrate) navigator.vibrate(pattern); }catch(e){} }

export {
  setSoundEnabled, isSoundEnabled, ensureAudio,
  playMatchSound, playSpecialSound, playSwapFail, playVeilCrack,
  playWinSound, playLoseSound,
  playSurgeSting, playFinaleSting, playGateSting, playStreakSting,
  playUiTap, playScreenIn, playScreenBack,
  startAmbientPad, stopAmbientPad, playMenuTheme,
  vibrate,
};
