/* harmonium.js — a reed organ played by the lid hinge.
 *
 * The mapping follows the real instrument. A harmonium makes no sound on its own:
 * one hand pumps the bellows for air, the other stops keys to pick notes. Here the
 * lid does both jobs — how far it is open picks the note, and *moving* it pumps air.
 * Hold the lid still and the sound dies away over a second or two, exactly as it
 * does when you stop pumping. Sustain mode pins the bellows open if you'd rather
 * just play with the angle.
 */
(function () {
"use strict";

const A_MIN = 20, A_MAX = 133;   // usable hinge travel, degrees
const TONIC_C4 = 261.626;        // Sa = C4 when untransposed
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const TAU = 1.15;                // bellows decay time constant, seconds
const FILL_PER_DEG = 0.085;      // air pushed per degree of lid travel

const RAGAS = {
  bhupali: { label: "Bhupali",  semis: [0, 2, 4, 7, 9] },
  yaman:   { label: "Yaman",    semis: [0, 2, 4, 6, 7, 9, 11] },
  bhairav: { label: "Bhairav",  semis: [0, 1, 4, 5, 7, 8, 11] },
  kafi:    { label: "Kafi",     semis: [0, 2, 3, 5, 7, 9, 10] },
  darbari: { label: "Darbari",  semis: [0, 2, 3, 5, 7, 8, 10] },
};
const SARGAM = ["S", "r", "R", "g", "G", "M", "M#", "P", "d", "D", "n", "N"];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- note layout ---------- */
let raga = RAGAS.bhupali, notes = [];
let tonicSemis = 0;   // transposition, so Sa can be moved to a backing track's key

const tonicFreq = () => TONIC_C4 * Math.pow(2, tonicSemis / 12);

function buildNotes() {
  const semis = raga.semis;
  const count = semis.length * 2 + 1;          // two octaves plus the closing Sa
  notes = [];
  for (let i = 0; i < count; i++) {
    const semi = semis[i % semis.length] + 12 * Math.floor(i / semis.length);
    notes.push({
      semi,
      freq: tonicFreq() * Math.pow(2, semi / 12),
      name: SARGAM[semis[i % semis.length]] + "'".repeat(Math.floor(i / semis.length)),
    });
  }
}

function setTonic(semis) {
  tonicSemis = semis;
  buildNotes();
  drawStrip();
  if (ctx) {
    const when = ctx.currentTime;
    for (const d of droneOscs) d.osc.frequency.setTargetAtTime(tonicFreq() * d.ratio, when, 0.03);
  }
  currentIdx = -1;   // force the melody reeds onto the new tuning next tick
}

function noteIndexFor(angle) {
  const t = clamp((angle - A_MIN) / (A_MAX - A_MIN), 0, 1);
  return clamp(Math.floor(t * notes.length), 0, notes.length - 1);
}

/* ---------- synthesis ---------- */
let ctx = null, master = null, analyser = null, analyserBuf = null;
let droneGain = null, melodyGain = null, airGain = null;
let melodyOscs = [], droneOscs = [], filters = [];
let running = false;

/* A free reed is harmonically rich with the odd partials a little forward of the
   even ones — that spectrum, not a plain sawtooth, is what reads as "reed organ". */
function reedWave() {
  const amps = [0, 1.0, 0.5, 0.62, 0.28, 0.32, 0.16, 0.18, 0.09, 0.10, 0.05, 0.06, 0.03];
  const real = new Float32Array(amps.length);
  const imag = new Float32Array(amps.length);
  for (let i = 0; i < amps.length; i++) imag[i] = amps[i];
  return ctx.createPeriodicWave(real, imag);
}

/* One reed bank: two oscillators a few cents apart. Harmoniums beat audibly because
   their banks are never in perfect tune, and that beating is most of the character. */
function reedBank(wave, freq, dest, spreadCents) {
  const oscs = [];
  for (const cents of [-spreadCents, spreadCents]) {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.value = freq;
    osc.detune.value = cents;
    osc.connect(dest);
    osc.start();
    oscs.push(osc);
  }
  return oscs;
}

function buildGraph() {
  const wave = reedWave();

  master = ctx.createGain();
  master.gain.value = 0.9;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.ratio.value = 12;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyserBuf = new Float32Array(analyser.fftSize);
  master.connect(limiter).connect(analyser).connect(ctx.destination);

  // More air opens the reeds up, so the filter tracks bellows pressure.
  const mkFilter = (dest) => {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 700;
    f.Q.value = 0.9;
    f.connect(dest);
    filters.push(f);
    return f;
  };

  droneGain = ctx.createGain(); droneGain.gain.value = 0;
  droneGain.connect(master);
  const droneFilter = mkFilter(droneGain);
  // Ratios kept alongside each bank so the drone can be retuned when Sa moves.
  droneOscs = [
    ...reedBank(wave, tonicFreq() * 0.5,  droneFilter, 4).map((o) => ({ osc: o, ratio: 0.5 })),
    ...reedBank(wave, tonicFreq() * 0.75, droneFilter, 5).map((o) => ({ osc: o, ratio: 0.75 })),
    ...reedBank(wave, tonicFreq() * 0.25, droneFilter, 3).map((o) => ({ osc: o, ratio: 0.25 })),
  ];

  melodyGain = ctx.createGain(); melodyGain.gain.value = 0;
  melodyGain.connect(master);
  const melodyFilter = mkFilter(melodyGain);
  melodyOscs = [
    ...reedBank(wave, tonicFreq(), melodyFilter, 6),      // 8' reed
    ...reedBank(wave, tonicFreq() * 2, melodyFilter, 7),  // 4' coupler, an octave up
  ];

  // Breath: the hiss of air through the bellows, only present while pumping.
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf; noise.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = 1800;
  airGain = ctx.createGain(); airGain.gain.value = 0;
  noise.connect(hp).connect(airGain).connect(master);
  noise.start();

  if (window.Voice) Voice.attach(ctx, master);

  // A slow tremolo, the natural unsteadiness of a hand-pumped bellows.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5.2;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.05;
  lfo.connect(lfoDepth).connect(master.gain);
  lfo.start();
}

/* ---------- bellows + playing state ---------- */
let pressure = 0, lastAngle = null, lastFrame = 0;
let currentIdx = -1, currentAngle = null;
let sustain = false, droneOn = true, volume = 0.7;

function feed(angle) {
  currentAngle = angle;
  if (lastAngle !== null) pressure = Math.min(1, pressure + Math.abs(angle - lastAngle) * FILL_PER_DEG);
  lastAngle = angle;
}

/* Driven by both requestAnimationFrame and a timer. rAF alone is smooth at 60fps
   but browsers throttle it in unfocused tabs, which would freeze the envelope and
   leave a note hanging; the interval keeps air draining even when the tab is idle.
   Everything below is dt-based, so being called twice in one frame is harmless. */
function tick(t) {
  const dt = lastFrame ? Math.min(0.1, t - lastFrame) : 0;
  lastFrame = t;

  if (sustain) pressure = 1;
  else pressure *= Math.exp(-dt / TAU);

  const idx = currentAngle === null ? -1 : noteIndexFor(currentAngle);
  if (idx !== currentIdx) {
    currentIdx = idx;
    if (running && idx >= 0) {
      // Glide rather than retrigger: reeds have no attack transient, and a short
      // ramp both matches how players slide between notes and avoids clicks.
      const f = notes[idx].freq, when = ctx.currentTime;
      melodyOscs[0].frequency.setTargetAtTime(f, when, 0.012);
      melodyOscs[1].frequency.setTargetAtTime(f, when, 0.012);
      melodyOscs[2].frequency.setTargetAtTime(f * 2, when, 0.012);
      melodyOscs[3].frequency.setTargetAtTime(f * 2, when, 0.012);
      if (window.Voice) Voice.setNote(f);
    }
  }

  if (running) {
    const p = pressure, when = ctx.currentTime;
    melodyGain.gain.setTargetAtTime(Math.pow(p, 1.3) * 0.42 * volume, when, 0.05);
    droneGain.gain.setTargetAtTime((droneOn ? Math.pow(p, 0.9) * 0.2 : 0) * volume, when, 0.08);
    airGain.gain.setTargetAtTime(p * 0.014 * volume, when, 0.05);
    for (const f of filters) f.frequency.setTargetAtTime(650 + p * 2600, when, 0.06);
  }
  if (window.Voice) {
    Voice.setLevel(running ? pressure : 0);
    if (currentAngle !== null) {
      Voice.setAperture((currentAngle - A_MIN) / (A_MAX - A_MIN));
    }
  }
  if (window.Backing) Backing.duck(running ? pressure : 0);
  render();
}

function frame(now) {
  requestAnimationFrame(frame);
  tick(now / 1000);
}

/* ---------- readout ---------- */
const $ = (id) => document.getElementById(id);

function outputLevel() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(analyserBuf);
  let sum = 0;
  for (let i = 0; i < analyserBuf.length; i++) sum += analyserBuf[i] * analyserBuf[i];
  return Math.sqrt(sum / analyserBuf.length);
}

function render() {
  const out = $("outBar");
  if (out) {
    const lvl = Math.min(1, outputLevel() * 3.2);
    out.style.width = (lvl * 100).toFixed(1) + "%";
    $("outVal").textContent = running ? Math.round(lvl * 100) + "%" : "off";
  }
  const bar = $("bellowsBar");
  if (bar) {
    bar.style.width = (pressure * 100).toFixed(1) + "%";
    $("bellowsVal").textContent = Math.round(pressure * 100) + "%";
  }
  const cells = $("sargam");
  if (cells && cells.children.length === notes.length) {
    for (let i = 0; i < notes.length; i++) cells.children[i].classList.toggle("on", i === currentIdx);
  }
  const ptr = $("sargamPtr");
  if (ptr && currentAngle !== null) {
    ptr.style.left = (clamp((currentAngle - A_MIN) / (A_MAX - A_MIN), 0, 1) * 100).toFixed(2) + "%";
  }
  const np = $("playingNote");
  if (np) np.textContent = currentIdx >= 0 ? notes[currentIdx].name : "—";
  const vw = $("vowel");
  if (vw && window.Voice) vw.textContent = Voice.isEnabled() ? Voice.vowel() : "off";
}

function drawStrip() {
  const wrap = $("sargam");
  if (!wrap) return;
  wrap.textContent = "";
  for (const n of notes) {
    const d = document.createElement("div");
    d.className = "key";
    d.textContent = n.name;
    d.title = Math.round(n.freq) + " Hz";
    wrap.appendChild(d);
  }
  currentIdx = -1;
}

/* ---------- controls ---------- */
async function start() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    buildGraph();
  }
  await ctx.resume();
  running = true;
  $("audioBtn").textContent = "Stop";
  $("audioBtn").classList.add("on");
}

/* Browsers throttle timers hard in a hidden tab, which would freeze the envelope and
   leave a note droning. Parking the context on hide also means a backgrounded
   dashboard never makes noise at you; the reeds pick up where they left off. */
function handleVisibility() {
  if (!ctx || !running) return;
  if (document.hidden) {
    ctx.suspend();
  } else {
    lastFrame = 0;   // don't bill the hidden time to the bellows
    pressure = 0;
    ctx.resume();
  }
}

function stop() {
  running = false;
  if (ctx) {
    const when = ctx.currentTime;
    melodyGain.gain.setTargetAtTime(0, when, 0.08);
    droneGain.gain.setTargetAtTime(0, when, 0.08);
    airGain.gain.setTargetAtTime(0, when, 0.08);
  }
  $("audioBtn").textContent = "Play";
  $("audioBtn").classList.remove("on");
}

function init() {
  buildNotes();
  drawStrip();
  $("audioBtn").addEventListener("click", () => (running ? stop() : start()));
  $("raga").addEventListener("change", (e) => {
    raga = RAGAS[e.target.value];
    buildNotes();
    drawStrip();
  });
  const sa = $("tonic");
  NOTE_NAMES.forEach((n, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = "Sa = " + n;
    sa.appendChild(o);
  });
  sa.value = "0";
  sa.addEventListener("change", (e) => setTonic(Number(e.target.value)));
  const vl = $("voiceLang");
  Object.keys(Voice.LANGS).forEach((k) => {
    const o = document.createElement("option");
    o.value = k; o.textContent = Voice.LANGS[k].label;
    vl.appendChild(o);
  });
  vl.value = "japanese";
  vl.addEventListener("change", (e) => Voice.setLang(e.target.value));
  $("voiceSrc").addEventListener("change", (e) => Voice.setSource(e.target.value));
  $("voiceChk").addEventListener("change", (e) => Voice.setEnabled(e.target.checked));
  $("voiceVol").addEventListener("input", (e) => Voice.setVolume(e.target.value / 100));
  $("droneChk").addEventListener("change", (e) => (droneOn = e.target.checked));
  $("sustainChk").addEventListener("change", (e) => {
    sustain = e.target.checked;
    if (!sustain) pressure = Math.min(pressure, 1);
  });
  $("vol").addEventListener("input", (e) => (volume = e.target.value / 100));
  document.addEventListener("visibilitychange", handleVisibility);
  requestAnimationFrame(frame);
  setInterval(() => tick(performance.now() / 1000), 50);
}

window.Harmonium = {
  init, feed, start, stop, setTonic,
  // Debug/demo hook: drive the instrument without touching the lid.
  simulate: (a) => feed(a),
  state: () => ({
    running, pressure, angle: currentAngle,
    note: currentIdx >= 0 ? notes[currentIdx].name : null,
    freq: currentIdx >= 0 ? notes[currentIdx].freq : null,
    ctxState: ctx ? ctx.state : "none",
    level: outputLevel(),
  }),
};
})();
