import { useState, useRef, useEffect } from 'react';

const API = 'http://localhost:5000';

/* ---------- synthesized pads (zero assets, all WebAudio) ---------- */
function noiseBuf(ctx, len, decay) {
  const n = ctx.sampleRate * len;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
  return buf;
}
function tone(ctx, dest, { type = 'sine', f0, f1, dur = 0.3, vol = 0.4, at = 0, slideType = 'exp', vibF = 0, vibA = 0 }) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 && slideType === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  if (f1 && slideType === 'lin') o.frequency.linearRampToValueAtTime(f1, t + dur);
  if (vibA) {
    const lfo = ctx.createOscillator(); lfo.frequency.value = vibF;
    const lg = ctx.createGain(); lg.gain.value = vibA;
    lfo.connect(lg); lg.connect(o.frequency); lfo.start(t); lfo.stop(t + dur);
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  // Simple soft compressor for warmth
  const comp = ctx.createGain();
  comp.gain.setValueAtTime(0.5, t); // compression ratio
  g.connect(comp);
  comp.exponentialRampToValueAtTime(0.001, t + dur);
  comp.connect(dest);
  o.connect(g);
  o.start(t); o.stop(t + dur + 0.05);
}
function noise(ctx, dest, { dur = 0.2, vol = 0.6, hf, lf, decay = 2, at = 0 }) {
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource(); src.buffer = noiseBuf(ctx, dur, decay);
  let node = src;
  if (hf) { const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hf; node.connect(f); node = f; }
  if (lf) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lf; node.connect(f); node = f; }
  const g = ctx.createGain();
  // Enhanced noise with punchier presence
  const comp = ctx.createGain();
  comp.gain.setValueAtTime(0.4, t);
  node.connect(comp);
  comp.gain.exponentialRampToValueAtTime(0.001, t + dur);
  comp.connect(dest);
  g.gain.setValueAtTime(vol, t);
  g.connect(comp);
  src.start(t);
}

export function synthPad(kind, ctx, dest) {
  const S = (o) => tone(ctx, dest, o);
  const N = (o) => noise(ctx, dest, o);
  switch (kind) {
    /* classic */
    case 'airhorn': S({ type: 'sawtooth', f0: 220, f1: 293, dur: 1.1, vol: 0.5, slideType: 'lin' }); S({ type: 'square', f0: 232, f1: 310, dur: 1.05, vol: 0.18, slideType: 'lin' }); break;
    case 'kick': S({ f0: 160, f1: 45, dur: 0.35, vol: 1 }); break;
    case 'snare': N({ dur: 0.2, vol: 0.8, hf: 1400, decay: 2.2 }); S({ f0: 180, f1: 120, dur: 0.1, vol: 0.3 }); break;
    case 'boop': S({ type: 'triangle', f0: 880, f1: 1320, dur: 0.35, vol: 0.4 }); break;
    case 'zap': S({ type: 'square', f0: 2200, f1: 180, dur: 0.3, vol: 0.35 }); break;
    case 'riser': S({ type: 'sawtooth', f0: 140, f1: 1400, dur: 0.9, vol: 0.4, slideType: 'exp' }); break;

    /* 8-bit (chiptune) */
    case '8jump': S({ type: 'square', f0: 330, f1: 660, dur: 0.18, vol: 0.35 }); S({ type: 'square', f0: 440, f1: 880, dur: 0.15, vol: 0.25, at: 0.05 }); break;
    case '8coin': S({ type: 'square', f0: 988, dur: 0.08, vol: 0.35 }); S({ type: 'square', f0: 1319, dur: 0.3, vol: 0.35, at: 0.08 }); break;
    case '8power': [523, 659, 784, 1047, 1319].forEach((f, i) => S({ type: 'square', f0: f, dur: 0.09, vol: 0.3, at: i * 0.07 })); break;
    case '8laser': S({ type: 'square', f0: 1800, f1: 320, dur: 0.28, vol: 0.3 }); break;
    case '8select': [784, 988].forEach((f, i) => S({ type: 'square', f0: f, dur: 0.08, vol: 0.3, at: i * 0.09 })); break;
    case '8over': [440, 415, 392, 349, 294].forEach((f, i) => S({ type: 'square', f0: f, dur: 0.18, vol: 0.3, at: i * 0.13 })); S({ type: 'triangle', f0: 147, f1: 73, dur: 0.7, vol: 0.3, at: 0.6 }); break;

    /* percussion */
    case 'clap': [0, 0.012, 0.026].forEach((at) => N({ dur: 0.06, vol: 0.5, hf: 900, decay: 3.5, at })); N({ dur: 0.25, vol: 0.25, hf: 800, decay: 2, at: 0.04 }); break;
    case 'tom': S({ f0: 220, f1: 90, dur: 0.3, vol: 0.8 }); N({ dur: 0.05, vol: 0.15, hf: 500, decay: 3 }); break;
    case 'hat': N({ dur: 0.08, vol: 0.5, hf: 7000, decay: 3 }); break;
    case 'cowbell': S({ type: 'square', f0: 540, dur: 0.25, vol: 0.3 }); S({ type: 'square', f0: 800, dur: 0.25, vol: 0.25 }); break;
    case 'rim': N({ dur: 0.05, vol: 0.6, hf: 3000, decay: 4 }); S({ type: 'square', f0: 1700, dur: 0.03, vol: 0.2 }); break;
    case 'whistle': S({ type: 'sine', f0: 2200, f1: 2400, dur: 0.5, vol: 0.35, slideType: 'lin', vibF: 30, vibA: 120 }); break;

    /* cinematic (premium) */
    case 'boom': S({ f0: 120, f1: 30, dur: 1.4, vol: 1 }); N({ dur: 1.2, vol: 0.4, lf: 300, decay: 2.5 }); break;
    case 'braam': [98, 147, 196, 294].forEach((f) => S({ type: 'sawtooth', f0: f, f1: f * 0.97, dur: 1.6, vol: 0.22, slideType: 'lin' })); N({ dur: 0.4, vol: 0.2, lf: 500, decay: 2, at: 0.5 }); break;
    case 'whoosh': N({ dur: 0.9, vol: 0.55, lf: 2400, decay: 1.2 }); break;
    case 'impact': N({ dur: 0.5, vol: 0.7, lf: 900, decay: 2 }); S({ f0: 90, f1: 36, dur: 0.8, vol: 0.8 }); break;
    case 'swell': S({ type: 'sawtooth', f0: 220, f1: 880, dur: 1.6, vol: 0.25, slideType: 'exp', vibF: 8, vibA: 30 }); S({ type: 'sawtooth', f0: 277, f1: 1108, dur: 1.6, vol: 0.18, slideType: 'exp', vibF: 7, vibA: 30 }); break;
    case 'stab': [523, 659, 784, 1047].forEach((f) => S({ type: 'sawtooth', f0: f, dur: 0.35, vol: 0.22 })); N({ dur: 0.25, vol: 0.3, hf: 1500, decay: 3 }); break;

    /* synthwave (premium) */
    case 'saw-lead': S({ type: 'sawtooth', f0: 440, f1: 880, dur: 0.5, vol: 0.4, slideType: 'exp' }); S({ type: 'sawtooth', f0: 443, f1: 884, dur: 0.5, vol: 0.25 }); break;
    case 'pulse-pad': [261, 329, 392].forEach((f, i) => S({ type: 'triangle', f0: f, dur: 0.8, vol: 0.18, at: i * 0.04 })); N({ dur: 0.8, vol: 0.06, lf: 800, decay: 1 }); break;
    case 'bass-drop': S({ f0: 110, f1: 28, dur: 1.1, vol: 1 }); N({ dur: 0.9, vol: 0.35, lf: 200, decay: 2 }); break;
    case 'arp-up': [523, 659, 784, 1047, 1319].forEach((f, i) => S({ type: 'sawtooth', f0: f, dur: 0.09, vol: 0.22, at: i * 0.07 })); break;
    case 'arp-down': [1319, 1047, 784, 659, 523].forEach((f, i) => S({ type: 'sawtooth', f0: f, dur: 0.09, vol: 0.22, at: i * 0.07 })); break;
    case 'chiff': N({ dur: 0.12, vol: 0.3, hf: 6000, decay: 3 }); S({ type: 'triangle', f0: 2400, f1: 1800, dur: 0.1, vol: 0.2 }); break;
    /* memes */
    case 'sad-trombone': [392, 370, 349, 311].forEach((f, i) => S({ type: 'sawtooth', f0: f, f1: f * 0.94, dur: 0.4, vol: 0.4, at: i * 0.35, vibF: 6, vibA: 12 })); break;
    case 'wow': S({ type: 'triangle', f0: 700, f1: 950, dur: 0.25, vol: 0.4 }); S({ type: 'triangle', f0: 950, f1: 640, dur: 0.5, vol: 0.4, at: 0.25 }); break;
    case 'yeet': S({ type: 'sawtooth', f0: 300, f1: 1800, dur: 0.4, vol: 0.45, slideType: 'exp' }); N({ dur: 0.3, vol: 0.25, hf: 4000, decay: 2 }); break;
    case 'bruh': S({ type: 'sawtooth', f0: 200, f1: 80, dur: 0.6, vol: 0.5, vibF: 25, vibA: 60 }); break;
    case 'vine-boom': S({ f0: 100, f1: 32, dur: 1.0, vol: 1 }); N({ dur: 0.7, vol: 0.4, lf: 250, decay: 2.2 }); break;
    case 'dun-dun': S({ type: 'sawtooth', f0: 147, f1: 110, dur: 0.35, vol: 0.5 }); S({ type: 'sawtooth', f0: 110, f1: 73, dur: 0.7, vol: 0.55, at: 0.38 }); break;
    /* sci-fi (premium) */
    case 'blaster': S({ type: 'square', f0: 1600, f1: 200, dur: 0.35, vol: 0.4 }); S({ type: 'square', f0: 1400, f1: 180, dur: 0.3, vol: 0.3, at: 0.05 }); break;
    case 'teleport': S({ type: 'sine', f0: 400, f1: 2400, dur: 0.6, vol: 0.35, slideType: 'exp', vibF: 60, vibA: 200 }); break;
    case 'sonar': S({ type: 'sine', f0: 740, dur: 0.5, vol: 0.4 }); S({ type: 'sine', f0: 740, dur: 0.5, vol: 0.4, at: 0.9 }); break;
    case 'alien': S({ type: 'sawtooth', f0: 500, f1: 380, dur: 0.8, vol: 0.35, vibF: 45, vibA: 180 }); break;
    case 'warp': S({ type: 'sawtooth', f0: 180, f1: 2600, dur: 1.4, vol: 0.4, slideType: 'exp' }); N({ dur: 1.2, vol: 0.2, hf: 3000, decay: 1.4 }); break;
    case 'computer': [880, 1174, 1568].forEach((f, i) => S({ type: 'square', f0: f, dur: 0.07, vol: 0.22, at: i * 0.1 })); break;
    /* nature */
    case 'rain': N({ dur: 1.6, vol: 0.35, hf: 5000, decay: 0.6 }); N({ dur: 1.4, vol: 0.2, hf: 3000, decay: 0.5, at: 0.3 }); break;
    case 'thunder': N({ dur: 1.8, vol: 0.7, lf: 400, decay: 1.6 }); S({ f0: 90, f1: 35, dur: 1.5, vol: 0.6, at: 0.1 }); break;
    case 'birds': [2200, 2600, 3100].forEach((f, i) => S({ type: 'sine', f0: f, f1: f * 1.3, dur: 0.12, vol: 0.25, at: i * 0.18, vibF: 40, vibA: 60 })); break;
    case 'waves': N({ dur: 2.2, vol: 0.4, lf: 900, decay: 0.9 }); N({ dur: 2.0, vol: 0.3, lf: 700, decay: 0.9, at: 1.4 }); break;
    case 'wind': N({ dur: 2.4, vol: 0.35, lf: 600, decay: 0.8 }); break;
    case 'cricket': [0, 0.35, 0.7].forEach((at) => S({ type: 'square', f0: 4200, dur: 0.04, vol: 0.15, at })); break;
    /* retro office (premium) */
    case 'type': [0, 0.09, 0.17, 0.28].forEach((at) => N({ dur: 0.04, vol: 0.35, hf: 4000, decay: 3, at })); break;
    case 'dial': [1209, 1336].forEach((f, i) => S({ type: 'sine', f0: f, dur: 0.18, vol: 0.25, at: i * 0.25 })); N({ dur: 0.8, vol: 0.15, hf: 2400, decay: 0.5, at: 0.7 }); break;
    case 'printer': [0, 0.08, 0.16, 0.24, 0.32].forEach((at) => N({ dur: 0.05, vol: 0.3, hf: 2500, decay: 2, at })); break;
    case 'fax': S({ type: 'sawtooth', f0: 1000, f1: 1800, dur: 0.9, vol: 0.25, vibF: 80, vibA: 300 }); break;
    case 'clicky': N({ dur: 0.03, vol: 0.4, hf: 5000, decay: 4 }); break;
    case 'paper': N({ dur: 0.4, vol: 0.25, hf: 3500, decay: 1.5 }); break;
    /* hip-hop kit (premium) */
    case '808': S({ f0: 80, f1: 38, dur: 0.9, vol: 1 }); break;
    case 'trap-hat': [0, 0.06, 0.12, 0.18].forEach((at) => N({ dur: 0.05, vol: 0.4, hf: 9000, decay: 3, at })); break;
    case 'snare-roll': [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35].forEach((at) => N({ dur: 0.04, vol: 0.3, hf: 1400, decay: 3, at })); break;
    case 'vinyl': S({ type: 'sawtooth', f0: 900, f1: 300, dur: 0.25, vol: 0.35 }); N({ dur: 0.15, vol: 0.2, hf: 2000, decay: 2 }); break;
    case 'sub-drop': S({ type: 'sine', f0: 60, f1: 24, dur: 1.3, vol: 0.9 }); break;
    case 'bell': S({ type: 'sine', f0: 1568, dur: 0.6, vol: 0.35 }); S({ type: 'sine', f0: 2349, dur: 0.4, vol: 0.18 }); break;
    /* horror (premium) */
    case 'stinger': N({ dur: 1.1, vol: 0.5, hf: 2200, decay: 1.1 }); S({ type: 'sawtooth', f0: 1800, f1: 90, dur: 1.0, vol: 0.4, vibF: 40, vibA: 400 }); S({ f0: 70, f1: 32, dur: 1.4, vol: 0.7, at: 0.05 }); break;
    case 'heart': S({ f0: 65, f1: 40, dur: 0.16, vol: 0.9 }); S({ f0: 58, f1: 36, dur: 0.2, vol: 0.8, at: 0.28 }); break;
    case 'whisper': N({ dur: 1.6, vol: 0.35, hf: 1000, lf: 6000, decay: 0.5 }); break;
    case 'creak': S({ type: 'sawtooth', f0: 300, f1: 180, dur: 1.1, vol: 0.2, slideType: 'lin', vibF: 18, vibA: 90 }); break;
    case 'drone': [55, 82.5, 110, 164].forEach((f) => S({ type: 'sawtooth', f0: f, dur: 2.4, vol: 0.16, vibF: 4 + Math.random() * 3, vibA: 6 })); break;
    case 'mbox': S({ type: 'triangle', f0: 1319, f1: 1319, dur: 0.5, vol: 0.3, vibF: 6, vibA: 14 }); S({ type: 'triangle', f0: 1047, f1: 1047, dur: 0.55, vol: 0.3, at: 0.55, vibF: 5, vibA: 12 }); N({ dur: 0.7, vol: 0.12, hf: 3000, decay: 1, at: 1.1 }); break;
  }
}

/* ---------- vocal fx (premium) ---------- */
function vfx(ctx, dest, { type = 'robot', dur = 0.4, vol = 0.4 }) {
  const t = ctx.currentTime;
  const f = ctx.createOscillator();
  const g = ctx.createGain();
  if (type === 'robot') { f.type = 'square'; f.frequency.setValueAtTime(220, t); f.frequency.setValueAtTime(180, t + dur); }
  else if (type === 'chipmunk') { f.type = 'sine'; f.frequency.setValueAtTime(880, t); f.frequency.setValueAtTime(1320, t + dur); }
  else if (type === 'deep') { f.type = 'sine'; f.frequency.setValueAtTime(55, t); f.frequency.setValueAtTime(28, t + dur); }
  else if (type === 'echo') { f.type = 'sine'; f.frequency.setValueAtTime(220, t); f.frequency.setValueAtTime(110, t + dur * 0.5); }
  else if (type === 'megaphone') { f.type = 'sawtooth'; f.frequency.setValueAtTime(220, t); }
  else if (type === 'walkie') { f.type = 'square'; f.frequency.setValueAtTime(300, t); f.frequency.setValueAtTime(250, t + dur); }
  else if (type === 'announcer') { f.type = 'square'; f.frequency.setValueAtTime(180, t); f.frequency.setValueAtTime(120, t + dur); }
  else if (type === 'glitch') { f.type = 'square'; f.frequency.setValueAtTime(440, t); f.frequency.setValueAtTime(550, t + dur * 0.3); f.frequency.setValueAtTime(330, t + dur * 0.6); }
  f.connect(g); g.gain.setValueAtTime(vol, t); g.connect(dest); f.start(t); f.stop(t + dur + 0.05);
}
function vfx2(ctx, dest, { type = 'robot', dur = 0.4, vol = 0.4 }) {
  const t = ctx.currentTime;
  const f = ctx.createOscillator();
  const n = ctx.createBufferSource();
  const g = ctx.createGain();
  if (type === 'robot') { f.type = 'square'; f.frequency.setValueAtTime(220, t); }
  else if (type === 'chipmunk') { f.type = 'sine'; f.frequency.setValueAtTime(880, t); }
  else if (type === 'deep') { f.type = 'sine'; f.frequency.setValueAtTime(55, t); }
  else if (type === 'echo') { f.type = 'sine'; f.frequency.setValueAtTime(220, t); f.frequency.setValueAtTime(110, t + dur * 0.5); }
  else if (type === 'megaphone') { f.type = 'sawtooth'; f.frequency.setValueAtTime(220, t); }
  else if (type === 'walkie') { f.type = 'square'; f.frequency.setValueAtTime(300, t); }
  else if (type === 'announcer') { f.type = 'square'; f.frequency.setValueAtTime(180, t); }
  else if (type === 'glitch') { f.type = 'square'; f.frequency.setValueAtTime(440, t); }
  const lfo = ctx.createOscillator(); lfo.frequency.value = 5;
  const lg = ctx.createGain(); lg.gain.value = 0.2;
  lfo.connect(lg); lg.connect(f.frequency); lfo.start(t); lfo.stop(t + dur);
  f.connect(g); g.gain.setValueAtTime(vol, t); g.connect(dest); n.buffer = noiseBuf(ctx, dur * ctx.sampleRate, 2); n.start(t); f.start(t); f.stop(t + dur + 0.05);
}

/* cinematic (premium) already above */

/* ---------- alarm & siren (premium) ---------- */
function alarm(ctx, dest, { type = 'siren', dur = 0.8, vol = 0.5 }) {
  const t = ctx.currentTime;
  const f = ctx.createOscillator();
  const n = ctx.createBufferSource();
  const g = ctx.createGain();
  if (type === 'siren') { f.type = 'sine'; f.frequency.setValueAtTime(440, t); f.frequency.exponentialRampToValueAtTime(200, t + dur); }
  else if (type === 'air-raid') { f.type = 'square'; f.frequency.setValueAtTime(200, t); f.frequency.setValueAtTime(400, t + dur); }
  else if (type === 'smoke') { f.type = 'sine'; f.frequency.setValueAtTime(500, t); f.frequency.setValueAtTime(600, t + dur); }
  else if (type === 'beep') { f.type = 'square'; f.frequency.setValueAtTime(800, t); f.frequency.setValueAtTime(400, t + dur * 0.5); f.frequency.setValueAtTime(200, t + dur * 0.8); }
  else if (type === 'clock') { f.type = 'sine'; f.frequency.setValueAtTime(1000, t); f.frequency.setValueAtTime(800, t + dur * 0.3); f.frequency.setValueAtTime(600, t + dur * 0.6); }
  else if (type === 'nuclear') { f.type = 'sine'; f.frequency.setValueAtTime(60, t); f.frequency.setValueAtTime(30, t + dur); }
  else if (type === 'police') { f.type = 'sine'; f.frequency.setValueAtTime(440, t); f.frequency.setValueAtTime(560, t + dur * 0.5); f.frequency.setValueAtTime(440, t + dur); }
  else if (type === 'fire') { f.type = 'sawtooth'; f.frequency.setValueAtTime(660, t); f.frequency.setValueAtTime(550, t + dur); }
  f.connect(g); g.gain.setValueAtTime(vol, t); g.connect(dest); f.start(t); f.stop(t + dur + 0.1);
  n.buffer = noiseBuf(ctx, dur * ctx.sampleRate * 0.6, 1.5);
  const ng = ctx.createGain(); ng.gain.setValueAtTime(vol * 0.3, t);
  n.connect(ng); ng.connect(dest);
}

/* ---------- fight & combat (premium) ---------- */
function fight(ctx, dest, { type = 'punch', dur = 0.3, vol = 0.5 }) {
  const t = ctx.currentTime;
  const f = ctx.createOscillator();
  const g = ctx.createGain();
  if (type === 'punch') { f.type = 'sine'; f.frequency.setValueAtTime(150, t); f.frequency.setValueAtTime(80, t + dur); }
  else if (type === 'sword') { f.type = 'square'; f.frequency.setValueAtTime(660, t); f.frequency.setValueAtTime(440, t + dur * 0.4); f.frequency.setValueAtTime(220, t + dur * 0.8); }
  else if (type === 'arrow') { f.type = 'sine'; f.frequency.setValueAtTime(880, t); f.frequency.setValueAtTime(660, t + dur); }
  else if (type === 'shield') { f.type = 'sine'; f.frequency.setValueAtTime(220, t); f.frequency.setValueAtTime(160, t + dur); }
  else if (type === 'explosion') { f.type = 'sawtooth'; f.frequency.setValueAtTime(120, t); f.frequency.setValueAtTime(60, t + dur); }
  else if (type === 'reload') { f.type = 'sine'; f.frequency.setValueAtTime(200, t); f.frequency.setValueAtTime(100, t + dur * 0.4); f.frequency.setValueAtTime(50, t + dur * 0.8); f.frequency.setValueAtTime(20, t + dur * 1.1); }
  else if (type === 'footstep') { f.type = 'sine'; f.frequency.setValueAtTime(120, t); f.frequency.setValueAtTime(60, t + dur); }
  else if (type === 'victory') { f.type = 'sine'; f.frequency.setValueAtTime(392, t); f.frequency.setValueAtTime(523, t + dur * 0.5); f.frequency.setValueAtTime(659, t + dur); }
  f.connect(g); g.gain.setValueAtTime(vol, t); g.connect(dest); f.start(t); f.stop(t + dur + 0.05);
}

/* ---------- vehicles ---------- */
function vehicle(ctx, dest, { type = 'engine', dur = 1.2, vol = 0.5 }) {
  const t = ctx.currentTime;
  const f = ctx.createOscillator();
  const g = ctx.createGain();
  if (type === 'engine') { f.type = 'sine'; f.frequency.setValueAtTime(110, t); f.frequency.setValueAtTime(88, t + dur); }
  else if (type === 'drift') { f.type = 'sawtooth'; f.frequency.setValueAtTime(220, t); f.frequency.setValueAtTime(180, t + dur); }
  else if (type === 'horn') { f.type = 'sine'; f.frequency.setValueAtTime(330, t); f.frequency.setValueAtTime(262, t + dur * 0.3); f.frequency.setValueAtTime(330, t + dur * 0.6); f.frequency.setValueAtTime(262, t + dur * 0.9); }
  else if (type === 'crash') { f.type = 'sawtooth'; f.frequency.setValueAtTime(200, t); f.frequency.setValueAtTime(80, t + dur); }
  else if (type === 'heli') { f.type = 'sine'; f.frequency.setValueAtTime(180, t); f.frequency.setValueAtTime(120, t + dur); }
  else if (type === 'tires') { f.type = 'sine'; f.frequency.setValueAtTime(440, t); f.frequency.setValueAtTime(330, t + dur * 0.25); f.frequency.setValueAtTime(220, t + dur * 0.5); f.frequency.setValueAtTime(155, t + dur * 0.75); }
  else if (type === 'convert') { f.type = 'square'; f.frequency.setValueAtTime(180, t); f.frequency.setValueAtTime(220, t + dur * 0.4); f.frequency.setValueAtTime(180, t + dur * 0.8); }
  f.connect(g); g.gain.setValueAtTime(vol, t); g.connect(dest); f.start(t); f.stop(t + dur + 0.1);
}

/* ---------- celebration ---------- */
function celebrate(ctx, dest, { type = 'fireworks', dur = 0.6, vol = 0.4 }) {
  const t = ctx.currentTime;
  const f = ctx.createOscillator();
  const g = ctx.createGain();
  if (type === 'fireworks') { f.type = 'sine'; f.frequency.setValueAtTime(880, t); f.frequency.setValueAtTime(1320, t + dur * 0.3); f.frequency.setValueAtTime(1760, t + dur * 0.5); f.frequency.setValueAtTime(2200, t + dur * 0.7); }
  else if (type === 'horn') { f.type = 'square'; f.frequency.setValueAtTime(330, t); f.frequency.setValueAtTime(523, t + dur * 0.3); f.frequency.setValueAtTime(659, t + dur * 0.5); f.frequency.setValueAtTime(784, t + dur * 0.7); }
  else if (type === 'champagne') { f.type = 'sine'; f.frequency.setValueAtTime(1568, t); f.frequency.setValueAtTime(2093, t + dur * 0.3); f.frequency.setValueAtTime(2637, t + dur * 0.5); f.frequency.setValueAtTime(3322, t + dur * 0.7); }
  else if (type === 'cheer') { f.type = 'sine'; f.frequency.setValueAtTime(200, t); f.frequency.setValueAtTime(300, t + dur * 0.2); f.frequency.setValueAtTime(400, t + dur * 0.4); f.frequency.setValueAtTime(500, t + dur * 0.6); }
  else if (type === 'confetti') { f.type = 'square'; f.frequency.setValueAtTime(1000, t); f.frequency.setValueAtTime(1200, t + dur * 0.2); f.frequency.setValueAtTime(1400, t + dur * 0.4); f.frequency.setValueAtTime(1600, t + dur * 0.6); }
  else if (type === 'gong') { f.type = 'sine'; f.frequency.setValueAtTime(196, t); f.frequency.setValueAtTime(247, t + dur); f.frequency.setValueAtTime(330, t + dur * 0.5); f.frequency.setValueAtTime(392, t + dur * 0.8); }
  else if (type === 'applause') { f.type = 'sine'; f.frequency.setValueAtTime(220, t); f.frequency.setValueAtTime(330, t + dur * 0.3); f.frequency.setValueAtTime(440, t + dur * 0.5); f.frequency.setValueAtTime(554, t + dur * 0.7); }
  f.connect(g); g.gain.setValueAtTime(vol, t); g.connect(dest); f.start(t); f.stop(t + dur + 0.1);
}

/* ---------- ui & app (premium) ---------- */
function uifx(ctx, dest, { type = 'success', dur = 0.2, vol = 0.4 }) {
  const t = ctx.currentTime;
  const f = ctx.createOscillator();
  const g = ctx.createGain();
  if (type === 'success') { f.type = 'sine'; f.frequency.setValueAtTime(523, t); f.frequency.setValueAtTime(659, t + dur * 0.3); f.frequency.setValueAtTime(784, t + dur * 0.5); }
  else if (type === 'error') { f.type = 'sine'; f.frequency.setValueAtTime(196, t); f.frequency.setValueAtTime(165, t + dur * 0.3); f.frequency.setValueAtTime(131, t + dur * 0.5); }
  else if (type === 'notification') { f.type = 'sine'; f.frequency.setValueAtTime(784, t); f.frequency.setValueAtTime(880, t + dur * 0.3); f.frequency.setValueAtTime(988, t + dur * 0.5); }
  else if (type === 'swipe') { f.type = 'square'; f.frequency.setValueAtTime(1000, t); f.frequency.setValueAtTime(800, t + dur * 0.3); f.frequency.setValueAtTime(600, t + dur * 0.5); }
  else if (type === 'click') { f.type = 'sine'; f.frequency.setValueAtTime(1000, t); f.frequency.setValueAtTime(800, t + dur * 0.2); }
  else if (type === 'alert') { f.type = 'square'; f.frequency.setValueAtTime(440, t); f.frequency.setValueAtTime(554, t + dur * 0.3); f.frequency.setValueAtTime(659, t + dur * 0.5); }
  else if (type === 'confirm') { f.type = 'sine'; f.frequency.setValueAtTime(523, t); f.frequency.setValueAtTime(659, t + dur * 0.3); f.frequency.setValueAtTime(784, t + dur * 0.5); f.frequency.setValueAtTime(1047, t + dur * 0.7); }
  f.connect(g); g.gain.setValueAtTime(vol, t); g.connect(dest); f.start(t); f.stop(t + dur + 0.05);
}

/* ---------- packs ---------- */
const PACKS = [
  {
    id: 'classic', name: 'Classic', emoji: '🎮', pro: false,
    pads: [
      { key: 'airhorn', label: 'Airhorn', emoji: '📢' },
      { key: 'kick', label: 'Kick', emoji: '🥊' },
      { key: 'snare', label: 'Snare', emoji: '🥁' },
      { key: 'boop', label: 'Boop', emoji: '🔮' },
      { key: 'zap', label: 'Zap', emoji: '⚡' },
      { key: 'riser', label: 'Riser', emoji: '🚀' },
    ],
  },
  {
    id: 'bit8', name: '8-Bit', emoji: '🕹️', pro: false,
    pads: [
      { key: '8jump', label: 'Jump', emoji: '🏃' },
      { key: '8coin', label: 'Coin', emoji: '🪙' },
      { key: '8power', label: 'Power Up', emoji: '🍄' },
      { key: '8laser', label: 'Laser', emoji: '🔫' },
      { key: '8select', label: 'Select', emoji: '✅' },
      { key: '8over', label: 'Game Over', emoji: '💀' },
    ],
  },
  {
    id: 'perc', name: 'Percussion', emoji: '🪘', pro: false,
    pads: [
      { key: 'clap', label: 'Clap', emoji: '👏' },
      { key: 'tom', label: 'Tom', emoji: '🪘' },
      { key: 'hat', label: 'Hi-Hat', emoji: '🎩' },
      { key: 'cowbell', label: 'Cowbell', emoji: '🐄' },
      { key: 'rim', label: 'Rimshot', emoji: '🥁' },
      { key: 'whistle', label: 'Whistle', emoji: '📣' },
    ],
  },
  {
    id: 'cine', name: 'Cinematic', emoji: '🎬', pro: true,
    pads: [
      { key: 'boom', label: 'Boom', emoji: '💥' },
      { key: 'braam', label: 'Braam', emoji: '📯' },
      { key: 'whoosh', label: 'Whoosh', emoji: '🌪️' },
      { key: 'impact', label: 'Impact', emoji: '🕳️' },
      { key: 'swell', label: 'Swell', emoji: '🌊' },
      { key: 'stab', label: 'Stab', emoji: '🔪' },
    ],
  },
  {
    id: 'horror', name: 'Horror', emoji: '👻', pro: true,
    pads: [
      { key: 'stinger', label: 'Stinger', emoji: '😱' },
      { key: 'heart', label: 'Heartbeat', emoji: '🫀' },
      { key: 'whisper', label: 'Whisper', emoji: '💬' },
      { key: 'creak', label: 'Creak', emoji: '🚪' },
      { key: 'drone', label: 'Drone', emoji: '🌀' },
      { key: 'd认oll', label: 'Music Box', emoji: '🎵' },
    ],
  },
];

export default function Soundboard({ premium, accent, disableHotkeys }) {
  const [packId, setPackId] = useState(() => localStorage.getItem('wp-sbpack') || 'classic');
  const [custom, setCustom] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wp-sb') || '[]'); } catch { return []; }
  });
  const [recording, setRecording] = useState(false);
  const [vol, setVol] = useState(0.7);
  const [toast, setToast] = useState('');
  const ctxRef = useRef(null);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const fileRef = useRef(null);

  function getCtx() {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    return ctxRef.current;
  }
  const MAX_FREE = 2, MAX_PRO = 12;
  const cap = premium ? MAX_PRO : MAX_FREE;
  const pack = PACKS.find((p) => p.id === packId) || PACKS[0];

  useEffect(() => { localStorage.setItem('wp-sbpack', packId); }, [packId]);

  useEffect(() => {
    function onKey(e) {
      if (disableHotkeys) return; // when user is gaming, hotkeys disabled
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const n = parseInt(e.key, 10);
      if (!n || n < 1) return;
      const pad = pack.pads[n - 1];
      if (pad) {
        if (pack.pro && !premium) { setToast(`✦ ${pack.name} pack is Premium`); return; }
        playBuiltin(pad.key);
        return;
      }
      const k = n - 1 - pack.pads.length;
      if (k >= 0 && custom[k]) playUrl(custom[k].url);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disableHotkeys, custom, packId, premium]);

  function playBuiltin(kind) {
    const ctx = getCtx();
    if (ctx.state === 'suspended') ctx.resume();
    synthPad(kind, ctx, ctx.destination);
  }
  async function playUrl(url) {
    const ctx = getCtx();
    if (ctx.state === 'suspended') ctx.resume();
    try {
      const buf = await (await fetch(`${API}${url}`)).arrayBuffer();
      const audio = await ctx.decodeAudioData(buf);
      const src = ctx.createBufferSource();
      src.buffer = audio;
      const g = ctx.createGain(); g.gain.value = vol;
      src.connect(g); g.connect(ctx.destination);
      src.start();
    } catch {}
  }

  async function saveCustom(name, dataUrl) {
    try {
      const r = await fetch(`${API}/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || 'pad', data: dataUrl }),
      });
      const j = await r.json();
      if (!j.track) throw new Error();
      const next = [...custom, { label: (name || 'pad').slice(0, 12), url: j.url }];
      setCustom(next);
      localStorage.setItem('wp-sb', JSON.stringify(next));
    } catch {}
  }

  function onPick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { setToast('Sound must be under 8MB'); return; }
    const fr = new FileReader();
    fr.onload = () => saveCustom(f.name.replace(/\.[^.]+$/, ''), fr.result);
    fr.readAsDataURL(f);
    e.target.value = '';
  }

  async function toggleRecord() {
    if (recording) { recRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => chunksRef.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        const fr = new FileReader();
        fr.onload = () => saveCustom('rec', fr.result);
        fr.readAsDataURL(blob);
        setRecording(false);
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch { setToast('Microphone blocked'); }
  }

  function pickPack(p) {
    if (p.pro && !premium) { setToast('✦ Cinematic & Horror packs are Premium'); return; }
    setPackId(p.id);
  }

  return (
    <div className="soundboard">
      <header className="hero">
        <h1>Sound <em>board</em></h1>
        <p className="sub">Hit a pad — or press keys <b>1</b>–<b>6</b> on your keyboard.</p>
        <div className="c-tabs">
          {PACKS.map((p) => (
            <button key={p.id} className={`c-tab ${packId === p.id ? 'active' : ''} ${p.pro && !premium ? 'locked' : ''}`} onClick={() => pickPack(p)}>
              {p.emoji} {p.name}{p.pro ? ' ✦' : ''}
            </button>
          ))}
        </div>
        <div className="sb-tools">
          <button className="pill" onClick={() => { if (!premium && custom.length >= cap) { setToast('Free saves 2 pads — ✦ Premium unlocks 12'); return; } fileRef.current?.click(); }}>＋ Import sound file</button>
          <button className={`pill ${recording ? 'rec' : ''}`} onClick={toggleRecord}>
            {recording ? '⏺ Stop recording' : '⏺ Record'}
          </button>
          <label className="pill volpill">Vol
            <input type="range" min="0" max="1" step="0.05" value={vol} onChange={(e) => setVol(+e.target.value)} />
          </label>
          <input ref={fileRef} type="file" accept="audio/*" hidden onChange={onPick} />
        </div>
        {toast && <div className="toast ok" onClick={() => setToast('')}>{toast}</div>}
      </header>

      <div className="pad-grid">
        {pack.pads.map((p, i) => (
          <button className="pad" key={p.key} onClick={() => playBuiltin(p.key)}>
            <span className="pad-emoji">{p.emoji}</span>
            <b>{p.label}</b>
            <small>{i + 1}</small>
          </button>
        ))}
      </div>

      <h2 className="results-title" style={{ marginTop: 26 }}>Your pads</h2>
      <div className="pad-grid" style={{ marginTop: 10 }}>
        {custom.slice(0, cap).map((p, i) => (
          <button className="pad custom" key={p.url} onClick={() => playUrl(p.url)}>
            <span className="pad-emoji">🔊</span>
            <b>{p.label}</b>
            <small>{pack.pads.length + i + 1}</small>
          </button>
        ))}
        {Array.from({ length: Math.max(0, cap - custom.length) }).map((_, i) => (
          <button className="pad ghost" key={'g' + i} onClick={() => fileRef.current?.click()}>
            <span className="pad-emoji">＋</span>
            <b>Add pad</b>
          </button>
        ))}
      </div>

      {!premium && (
        <p className="sub" style={{ marginTop: 16 }}>
          Free saves 2 custom pads + 3 sound packs — <b>✦ Wicked Premium</b> unlocks Cinematic & Horror packs, 12 pads & gold pads ✨
        </p>
      )}
    </div>
  );
}
