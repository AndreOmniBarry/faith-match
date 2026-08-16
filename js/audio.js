/* ============================= AUDIO ============================= */
// Real playback, built around files you drop into assets/audio/ — see
// assets/audio/README.md for the exact filenames each slot looks for.
// Every slot degrades to silence if its file isn't present yet (checked
// once via a lightweight probe, never a thrown/console error), so this
// works today with zero files and picks up each track/effect the moment
// it's added, with no code change needed.

const MUSIC_DIR = 'assets/audio/music/';
const SFX_DIR = 'assets/audio/sfx/';
const EXTS = ['mp3', 'ogg', 'wav']; // wav last so a supplied mp3/ogg always wins over a synthesized fallback

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

// Warm the menu theme into the cache as soon as this module loads — a
// silent network preload, no playback. By the time the player actually
// taps "Begin" (at least a second or two later), the element is already
// resolved, so getMusic()'s cache-hit branch below returns *synchronously*
// and ensureAudio() can call .play() within that same click's call stack.
// That's the fix for "had to toggle sound off/on before it started
// playing": the old code unlocked with a src-less dummy element, which
// doesn't reliably register as a real gesture-triggered play in every
// browser, and the *real* first play (from switchMusic's async probe
// callback) landed too late to still count as gesture-initiated. Toggling
// sound worked because it calls .play() directly on an already-loaded
// cached element — this makes the very first tap behave the same way.
getMusic('theme-main', () => {});

function setSoundEnabled(v){
  soundOn = v;
  if(!v && currentMusic) currentMusic.el.pause();
  else if(v && currentMusic){
    const rec = currentMusic;
    rec.el.play().then(() => { rec.confirmed = true; }).catch(()=>{});
  }
}
function isSoundEnabled(){ return soundOn; }

function ensureAudio(){
  // Call from a real user-gesture handler (first tap) — some browsers
  // (iOS Safari in particular) refuse to play any audio, even muted,
  // until playback has been kicked off inside a click/tap event. Starting
  // the actual menu theme here (rather than a throwaway silent element)
  // both unlocks audio and gets the music going immediately, with no
  // second interaction needed.
  if(unlocked) return;
  unlocked = true;
  playMenuTheme();
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
// Meter reaching full is a distinct moment from actually tapping it to
// fire (playSurgeSting) — the player should hear "that's ready" the
// instant it caps, not just discover it visually.
function playMeterReady(){ playSfx('meter-ready', { volume: 0.6 }); }
// Any gems/items actually landing in the player's account — level
// rewards, chapter bonus, daily reward — not just a generic win chime.
function playRewardChime(){ playSfx('reward', { volume: 0.6 }); }

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
  // Only skip re-triggering if that track is both current *and* actually
  // confirmed playing — see the .confirmed handling below for why that
  // distinction is the whole fix for a real bug: the very first play()
  // attempt right after the page's first tap can get blocked by the
  // browser's autoplay gate even though the tap was genuine (a Chromium
  // activation-propagation timing quirk, not a code mistake). The old
  // code marked currentMusic as that key regardless of whether play()
  // actually succeeded, so every later legitimate call (a screen change,
  // starting a level) saw "already on this track" and silently no-op'd
  // forever — the track never played until something bypassed this check
  // entirely, like the sound toggle calling .play() directly. Rolling
  // currentMusic back to null on a failed attempt lets the next real call
  // retry cleanly instead of getting stuck.
  if(currentMusic && currentMusic.key === key && currentMusic.confirmed) return;
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
    const rec = { key, el, confirmed: false };
    currentMusic = rec;
    el.play().then(() => { rec.confirmed = true; }).catch(() => {
      if(currentMusic === rec) currentMusic = null;
    });
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
// The World Map gets its own dedicated track (theme-map) distinct from
// the shared menu theme — falls back to the regular menu theme if that
// file isn't present.
function playMapTheme(){
  getMusic('theme-map', (el) => {
    switchMusic(el ? 'theme-map' : 'theme-main', { volume: 0.3 });
  });
}

function vibrate(pattern){ try{ if(navigator.vibrate) navigator.vibrate(pattern); }catch(e){} }

export {
  setSoundEnabled, isSoundEnabled, ensureAudio,
  playMatchSound, playSpecialSound, playSwapFail, playVeilCrack,
  playWinSound, playLoseSound,
  playSurgeSting, playFinaleSting, playGateSting, playStreakSting,
  playMeterReady, playRewardChime,
  playUiTap, playScreenIn, playScreenBack,
  startAmbientPad, stopAmbientPad, playMenuTheme, playMapTheme,
  vibrate,
};
