/* ============================= AUDIO (synth, zero assets) ============================= */

let audioCtx = null;
let soundOn = true;

function setSoundEnabled(v){
  soundOn = v;
  if(soundOn) ensureAudio();
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

function playMatchSound(step){
  const base = 440 + Math.min(step,5)*60;
  beep(base, 0.14, 'sine', 0.14);
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

function vibrate(pattern){ try{ if(navigator.vibrate) navigator.vibrate(pattern); }catch(e){} }

export {
  setSoundEnabled, isSoundEnabled, ensureAudio,
  playMatchSound, playSpecialSound, playSwapFail, playVeilCrack,
  playWinSound, playLoseSound, vibrate,
};
