/* ============================= AUDIO (silent placeholder) ============================= */
// The synth beep/stinger system has been intentionally muted — the sound
// was rejected. The user is composing/bringing their own audio instead.
// Every call site in engine.js/screens.js still calls these functions (so
// nothing else needs to change when real audio lands), they just don't
// produce sound right now. Vibration is untouched — that's haptics, not
// noise, and wasn't part of the complaint.
//
// To wire in real audio later: keep this same function surface, but have
// each function play/trigger a provided audio asset (or a new synth
// design) instead of doing nothing.

let soundOn = true;

function setSoundEnabled(v){ soundOn = v; }
function isSoundEnabled(){ return soundOn; }
function ensureAudio(){ /* no-op until real audio is wired in */ }

function playMatchSound(){}
function playSpecialSound(){}
function playSwapFail(){}
function playVeilCrack(){}
function playWinSound(){}
function playLoseSound(){}
function playSurgeSting(){}
function playFinaleSting(){}
function playGateSting(){}
function playStreakSting(){}
function playUiTap(){}
function playScreenIn(){}
function playScreenBack(){}
function startAmbientPad(){}
function stopAmbientPad(){}

function vibrate(pattern){ try{ if(navigator.vibrate) navigator.vibrate(pattern); }catch(e){} }

export {
  setSoundEnabled, isSoundEnabled, ensureAudio,
  playMatchSound, playSpecialSound, playSwapFail, playVeilCrack,
  playWinSound, playLoseSound,
  playSurgeSting, playFinaleSting, playGateSting, playStreakSting,
  playUiTap, playScreenIn, playScreenBack,
  startAmbientPad, stopAmbientPad,
  vibrate,
};
