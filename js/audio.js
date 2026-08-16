/* ============================= AUDIO (synth, zero assets) ============================= */
// Everything here is a Web Audio oscillator graph — no audio files, so the
// game stays instant-loading. This pass widens the *variety* of reactions
// (per-symbol match tones, more stingers, an ambient pad, UI chimes); a
// full melodic theme and any recorded voice work is a separate session.

let audioCtx = null;
let soundOn = true;
let padNodes = null; // { oscA, oscB, gain } while the ambient pad is running

function setSoundEnabled(v){
  soundOn = v;
  if(soundOn) ensureAudio();
  else stopAmbientPad();
}
function isSoundEnabled(){ return soundOn; }

function ensureAudio(){
  if(audioCtx || !soundOn) return;
  try{ audioCtx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){}
}

function beep(freq, dur, type, vol, delay){
  if(!soundOn || !audioCtx) return;
  try{
    const t0 = audioCtx.currentTime + (delay||0);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(vol!=null?vol:0.16, t0+0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, t0+(dur||0.14));
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0+(dur||0.14)+0.03);
  }catch(e){}
}

// A gentle upward or downward pitch sweep — the closest a simple oscillator
// graph gets to a "whoosh," used for screen transitions.
function sweep(fromFreq, toFreq, dur, vol){
  if(!soundOn || !audioCtx) return;
  try{
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(fromFreq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1,toFreq), t0+dur);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(vol!=null?vol:0.08, t0+dur*0.3);
    gain.gain.exponentialRampToValueAtTime(0.001, t0+dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0+dur+0.03);
  }catch(e){}
}

// One tone per symbol type (a pentatonic-ish run across ~an octave) so
// matching different symbols sounds different, not just louder with combo
// step. Oscillator type alternates for a little timbral variety too.
const SYMBOL_TONES = [523.25, 587.33, 659.25, 698.46, 783.99, 880.00, 987.77, 1046.50];
const SYMBOL_WAVES = ['sine','triangle','sine','triangle','sine','triangle','sine','triangle'];

function playMatchSound(step, typeIndex){
  const idx = typeIndex!=null ? typeIndex % SYMBOL_TONES.length : 0;
  const base = SYMBOL_TONES[idx] * (1 + Math.min(step,5)*0.04);
  beep(base, 0.15, SYMBOL_WAVES[idx], 0.13);
}
function playSpecialSound(tier){
  // tier: 'striped' | 'wrapped' | 'colorbomb' | 'combo'
  if(tier==='colorbomb' || tier==='combo'){
    [260,390,520,700].forEach((f,i)=>beep(f,0.16,'square',0.13,i*0.05));
  }else if(tier==='wrapped'){
    beep(220,0.14,'square',0.12); beep(440,0.16,'sine',0.13,0.05);
  }else{
    beep(300,0.1,'square',0.1); beep(600,0.12,'sine',0.12,0.06);
  }
}
function playSwapFail(){ beep(160,0.09,'square',0.09); }
function playVeilCrack(){ beep(140,0.08,'sawtooth',0.09); }
function playWinSound(){
  [523,659,784,1046].forEach((f,i)=>beep(f,0.18,'triangle',0.15, i*0.11));
}
function playLoseSound(){ beep(280,0.2,'sawtooth',0.08); beep(200,0.25,'sawtooth',0.08,0.15); }

/* ---------- new reaction stingers ---------- */
function playSurgeSting(){ // Combo Surge meter pop
  [330,494,660,880].forEach((f,i)=>beep(f,0.15,'triangle',0.14,i*0.045));
}
function playFinaleSting(){ // entering a stage finale
  [392,523,659,784,1046].forEach((f,i)=>beep(f,0.2,'sawtooth',0.1,i*0.06));
}
function playGateSting(){ // chapter star-gate reached (locked or cleared, same cue)
  beep(660,0.12,'square',0.11); beep(494,0.16,'square',0.1,0.08);
}
function playStreakSting(streak){ // daily streak milestone
  const notes = [523,659,784];
  if(streak>=7) notes.push(1046);
  notes.forEach((f,i)=>beep(f,0.17,'triangle',0.14,i*0.07));
}

/* ---------- UI feedback ---------- */
function playUiTap(){ beep(720,0.05,'sine',0.06); }
function playScreenIn(){ sweep(300,900,0.22,0.05); }
function playScreenBack(){ sweep(700,260,0.2,0.05); }

/* ---------- ambient pad (game screen only) ---------- */
// Two quiet, slightly detuned oscillators — a held drone, not a melody.
// Full theme music is a separate session; this just keeps the game screen
// from being silent under the sound effects.
function startAmbientPad(){
  if(!soundOn || padNodes) return;
  ensureAudio();
  if(!audioCtx) return;
  try{
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.025, audioCtx.currentTime+1.2);
    const oscA = audioCtx.createOscillator();
    const oscB = audioCtx.createOscillator();
    oscA.type = 'sine'; oscA.frequency.value = 130.81; // C3
    oscB.type = 'sine'; oscB.frequency.value = 196.00; // G3 — a fifth above, calm/open
    oscA.connect(gain); oscB.connect(gain); gain.connect(audioCtx.destination);
    oscA.start(); oscB.start();
    padNodes = { oscA, oscB, gain };
  }catch(e){}
}
function stopAmbientPad(){
  if(!padNodes || !audioCtx) { padNodes = null; return; }
  try{
    const { oscA, oscB, gain } = padNodes;
    const t0 = audioCtx.currentTime;
    gain.gain.linearRampToValueAtTime(0, t0+0.6);
    oscA.stop(t0+0.65); oscB.stop(t0+0.65);
  }catch(e){}
  padNodes = null;
}

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
