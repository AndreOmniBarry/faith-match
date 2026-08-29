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
// name -> array of callbacks waiting on a probe that's already in flight.
// Without this, two calls for the same key made before the first probe
// resolves (e.g. the module-load pre-warm below racing a real user tap on
// a slower network, like an actual deployed host vs. localhost) would each
// kick off their own probe() and end up with two *separate* <audio>
// elements for the same file — both get played, and you hear the same
// track twice, out of phase. Coalescing here means every caller for a
// given key, however many arrive before it resolves, shares one probe and
// one element.
const musicPending = new Map();
const sfxPending = new Map();
let currentMusic = null; // { key, el }
// The key a switchMusic() call is *waiting* on a still-in-flight probe for,
// as opposed to currentMusic (which only reflects an already-resolved
// switch). Without this, several switchMusic() calls for the same key
// arriving before the first one's probe resolves -- routine now that
// ensureAudio() retries on every tap (see screens.js's pointerdown
// listener) -- would each queue their own callback behind the shared
// probe, and every one of them would fire once it resolves: the same
// track gets .play()'d and fadeTo()'d several times back to back.
let pendingSwitchKey = null;

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

// Shared cache+coalesce logic behind getMusic/getSfx — see musicPending's
// comment above for why the pending-queue step matters.
function getCached(dir, cache, pending, key, cb){
  if(cache.has(key)){ cb(cache.get(key)); return; }
  if(pending.has(key)){ pending.get(key).push(cb); return; }
  pending.set(key, [cb]);
  probe(dir + key, (el) => {
    cache.set(key, el);
    const waiters = pending.get(key) || [];
    pending.delete(key);
    waiters.forEach(fn => fn(el));
  });
}

function getMusic(key, cb){ getCached(MUSIC_DIR, musicCache, musicPending, key, cb); }
function getSfx(key, cb){ getCached(SFX_DIR, sfxCache, sfxPending, key, cb); }

// Warm theme-map into the cache as soon as this module loads — a silent
// network preload, no playback. By the time the player actually taps
// "Begin" (at least a second or two later), the element is already
// resolved, so getMusic()'s cache-hit branch below returns *synchronously*
// and ensureAudio() can call .play() within that same click's call stack.
// That's the fix for "had to toggle sound off/on before it started
// playing": the old code unlocked with a src-less dummy element, which
// doesn't reliably register as a real gesture-triggered play in every
// browser, and the *real* first play (from switchMusic's async probe
// callback) landed too late to still count as gesture-initiated. Toggling
// sound worked because it calls .play() directly on an already-loaded
// cached element — this makes the very first tap behave the same way.
// theme-map specifically (not theme-main) because every non-game screen —
// splash included — now shares that one track (see screens.js's
// showScreen()), so this is the track ensureAudio() actually needs warm.
getMusic('theme-map', () => {});

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
  // the actual theme here (rather than a throwaway silent element) both
  // unlocks audio and gets the music going immediately, with no second
  // interaction needed. Targets playMapTheme() (not playMenuTheme()), same
  // as every screen now does — so this first unlock and showScreen()'s own
  // call right after it resolve to the same track and switchMusic()'s
  // same-key guard makes it a no-op the second time, instead of unlocking
  // into one track and immediately re-fading into another.
  if(unlocked){
    // Already unlocked, but the very first attempt can still have lost its
    // gesture-activation window silently: getMusic()'s probe is async, and
    // on a real (non-instant) network the tap's activation can expire
    // before el.play() ever actually runs, so it just fails quietly
    // (switchMusic's .catch resets currentMusic to null). That reads
    // exactly like "sound says on but won't play" — a real-network-only
    // bug this session's near-instant localhost tests never hit. Any
    // later real tap is itself a fresh gesture, so retry here rather than
    // leaving music silently stuck off for the rest of the session.
    if(soundOn && !currentMusic) playMapTheme();
    return;
  }
  unlocked = true;
  playMapTheme();
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
// Called from nearly every button in the app — the natural place to retry
// music if the very first attempt silently lost its autoplay-gesture
// window (see ensureAudio()'s comment). Every tap is a fresh, legitimate
// gesture, so this is a real retry, not a background autoplay attempt.
function playUiTap(){ ensureAudio(); playSfx('tap', { volume: 0.35 }); }
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

function switchMusic(key, { volume = 0.35, fadeMs = 600, fallbackKey = null } = {}){
  // Skip re-triggering whenever that track is already current — whether
  // its play() has *confirmed* yet or is still pending, not just once
  // confirmed. Screen transitions fire this back-to-back synchronously
  // (splash -> loading -> modes -> map each call playMapTheme() on the way),
  // and before this guard covered the pending state too, the second call
  // would land while the first's play() promise hadn't resolved yet,
  // treat itself as a fresh switch, and restart a competing fade-out (with
  // its pause+currentTime-reset callback) and fade-in *on the very track
  // it was about to redundantly re-play* — audible as a stutter/duplicate.
  // A failed play() attempt still resets currentMusic to null (see the
  // .catch below), which is what lets a genuine retry through — that part
  // of the original fix for "stuck silent after a blocked autoplay" is
  // unchanged.
  if(currentMusic && currentMusic.key === key) return;
  if(pendingSwitchKey === key) return;
  const prev = currentMusic;
  currentMusic = null;
  if(prev){
    fadeTo(prev.el, 0, fadeMs, () => { prev.el.pause(); prev.el.currentTime = 0; });
  }
  if(!soundOn) return;
  pendingSwitchKey = key;
  getMusic(key, (el) => {
    if(pendingSwitchKey === key) pendingSwitchKey = null;
    if(!el){
      // The file just isn't there yet — try the fallback track (still just
      // one more getMusic hop, only on this cold path, not the common one).
      // Deliberately NOT the structure this replaced: that wrapped every
      // switchMusic() call in its own *outer* getMusic() first and only
      // called switchMusic() from inside that callback, doubling the async
      // hop between a tap and the actual .play() call on every single
      // call, not just a missing-file one. Chromium's autoplay policy
      // tolerated that fine in testing, but it's exactly the kind of gap
      // stricter mobile browsers (iOS Safari in particular, which requires
      // play() to land essentially synchronously inside the gesture) don't
      // forgive — which is what silenced every non-gameplay track (splash
      // included) after that structure shipped. This keeps the common,
      // file-present path at the same single getMusic hop playMenuTheme()
      // and startAmbientPad()'s own fallback-free calls already use.
      if(fallbackKey) switchMusic(fallbackKey, { volume, fadeMs });
      return;
    }
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
  if(mode) switchMusic(`theme-${mode}`, { fallbackKey: 'theme-gameplay' });
  else switchMusic('theme-gameplay');
}
function stopAmbientPad(){
  if(!currentMusic) return;
  const prev = currentMusic;
  currentMusic = null;
  fadeTo(prev.el, 0, 500, () => { prev.el.pause(); prev.el.currentTime = 0; });
}
// Kept for any external caller that still wants the old, splash-only
// track — nothing in this app calls it anymore (see playMapTheme below).
function playMenuTheme(){ switchMusic('theme-main', { volume: 0.3 }); }
// Every non-game screen shares this one track now, splash included — see
// screens.js's showScreen() and ensureAudio() above. Falls back to
// theme-main if theme-map isn't present.
function playMapTheme(){ switchMusic('theme-map', { volume: 0.3, fallbackKey: 'theme-main' }); }

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
