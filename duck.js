/* duck.js — the harmonium runs on a rubber duck.
 *
 * A rubber duck is a bellows with a free reed in it: squeeze, and air is forced past a
 * thin tongue that flaps and makes a tone. That is exactly, mechanically, what a
 * harmonium is. So the duck is a one-note harmonium, and this file wires the small one
 * to the big one — you pump a real reed to power a synthesised one, and the laptop
 * makes no sound until you do.
 *
 * The lid still picks the note and still works the virtual bellows for air. The duck
 * supplies permission, which drains in about eight seconds, so playing anything longer
 * than a phrase means squeezing on a steady beat while the other hand works the hinge.
 *
 * ---- detection ----
 *
 * Not speech recognition — this is audio event detection. A squeak is a short broadband
 * transient somewhere around 1-4 kHz, but the exact pitch depends entirely on the size
 * of the duck, so nothing is hardcoded. Calibration averages the normalised magnitude
 * spectrum of a few real squeezes into a template, and a frame counts as a squeak when
 * it clears three independent tests:
 *
 *   1. LOUD    — band energy well above an adaptive noise floor, so a quiet room and a
 *                loud one both work without a knob.
 *   2. SUDDEN  — positive spectral flux, i.e. an onset. This is what stops a sustained
 *                tone at the same pitch (a voice, a hum, the harmonium's own output
 *                through the speakers) from holding the gate open forever.
 *   3. SHAPED  — cosine similarity against the learned template, which is level
 *                invariant because both vectors are L2 normalised.
 *
 * Uncalibrated it falls back to tests 1 and 2 over a generic 1-4 kHz band, which works
 * for most ducks and means the thing is never dead on arrival.
 */
(function () {
"use strict";

/* ---------- tuning ---------- */

const FFT = 2048;              // ~23 Hz bins at 48k; 43 ms window, short enough for a squeak
const BAND_LO = 700, BAND_HI = 7000;   // where squeakers live, generously bracketed
const FALLBACK_LO = 1000, FALLBACK_HI = 4000;

let TAU = 8;                   // seconds; permission drains about as fast as you can re-squeeze
let PER_SQUEEZE = 0.55;        // charge per detected squeak — two gets you to full
let SIM_MIN = 0.80;            // cosine similarity against the template
let ENERGY_MULT = 4.5;         // how far above the noise floor counts as loud
let FLUX_MIN = 0.28;           // onset sharpness, as a fraction of frame energy
let REFRACTORY = 0.13;         // seconds; a squeeze and its release may both fire, which is fine

const FLOOR_TAU = 2.0;         // adaptive noise floor time constant
const STORE_KEY = "lidangle.duck.template";

/* ---------- state ---------- */

let ctx = null, analyser = null, freq = null, stream = null;
let lo = 0, hi = 0, nbins = 0;
let subLo = 0, subHi = 0;   // uncalibrated tests run over this narrower slice
let prevMag = null, floorEnergy = 0;
let template = null;           // Float32Array, L2 normalised, or null when uncalibrated

let charge = 0, lastTick = 0, locked = true;
let armed = false, lastFire = 0, lastSim = 0, lastEnergy = 0, lastFlux = 0;
let note = "", noteUntil = 0, hits = 0;

let calibrating = false, calFrames = [], calUntil = 0, calEvents = [];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const now = () => performance.now() / 1000;

/* ---------- dsp ---------- */

function binOf(hz) { return Math.round(hz / (ctx.sampleRate / FFT)); }

/* Analyser dB -> linear magnitude across the whole band. The band is fixed regardless
   of calibration state, so a saved template always lines up with a freshly opened mic. */
function readBand(out) {
  analyser.getFloatFrequencyData(freq);
  for (let i = 0; i < nbins; i++) {
    const db = freq[lo + i];
    out[i] = db <= -140 ? 0 : Math.pow(10, db / 20);
  }
}

function energyOf(m, a, b) {
  let e = 0;
  for (let i = a; i < b; i++) e += m[i];
  return e;
}

/* Spectral flux: how much of this frame is *new* energy. Rectified, so a decaying tone
   contributes nothing — only rises count, which is what makes this an onset detector
   rather than a level meter. */
function fluxOf(m, a, b) {
  if (!prevMag) return 0;
  let f = 0;
  for (let i = a; i < b; i++) {
    const d = m[i] - prevMag[i];
    if (d > 0) f += d;
  }
  return f;
}

function normalise(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n < 1e-9) return null;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/* ---------- detection ---------- */

let mag = null, unit = null;

function detect() {
  const t = now();
  readBand(mag);

  // Calibrated, the template does the duck-specific work, so loudness is judged over
  // the whole band. Uncalibrated there is nothing to match against, so the level and
  // onset tests are narrowed to where squeakers actually live — otherwise a clap or a
  // keyboard would read as broadband enough to pass.
  const a = template ? 0 : subLo, b = template ? nbins : subHi;
  const energy = energyOf(mag, a, b);
  const flux = fluxOf(mag, a, b);
  lastEnergy = energy;
  lastFlux = energy > 0 ? flux / energy : 0;

  const u = normalise(mag);
  lastSim = u && template ? cosine(u, template) : 0;
  unit = u;

  const loud = energy > Math.max(floorEnergy * ENERGY_MULT, 1e-5);
  const sudden = lastFlux > FLUX_MIN;
  const shaped = template ? lastSim > SIM_MIN : true;

  // The floor tracks the room, but only while nothing is happening — otherwise a long
  // squeeze would raise the very threshold it needs to clear.
  if (!loud) {
    const a = 1 - Math.exp(-0.016 / FLOOR_TAU);
    floorEnergy += (energy - floorEnergy) * a;
  }

  if (calibrating) {
    collect(t, energy, mag, loud, sudden);
  } else if (loud && sudden && shaped && t - lastFire > REFRACTORY && armed) {
    lastFire = t;
    hits++;
    // A harder squeeze pays a little more, but only a little.
    const strength = clamp(energy / Math.max(floorEnergy * ENERGY_MULT, 1e-9) / 3, 0.7, 1.4);
    charge = clamp(charge + PER_SQUEEZE * strength, 0, 1);
    lastHitAt = t;
    say(charge > 0.9 ? "good duck." : "quack");
  }

  prevMag = Float32Array.from(mag);
}

/* ---------- calibration ---------- */

/* Six seconds of listening. Every loud onset frame is kept with its timestamp, then
   grouped into events by time gaps — one squeeze usually gives two, a push and a
   release, and both are equally the duck. The peak frame of each event is normalised
   and the events are averaged, so the template describes the duck's shape rather than
   any one squeeze's loudness. */
function collect(t, energy, m, loud, sudden) {
  if (t > calUntil) return finishCalibration();
  if (loud && sudden) calFrames.push({ t, energy, mag: Float32Array.from(m) });
  const left = Math.max(0, calUntil - t);
  say("listening… " + left.toFixed(1) + "s, " + countEvents(calFrames) + " so far");
}

function countEvents(frames) {
  let n = 0, last = -99;
  for (const f of frames) { if (f.t - last > 0.25) n++; last = f.t; }
  return n;
}

function groupEvents(frames) {
  const events = [];
  let cur = null, last = -99;
  for (const f of frames) {
    if (f.t - last > 0.25) { cur = []; events.push(cur); }
    cur.push(f);
    last = f.t;
  }
  return events;
}

function finishCalibration() {
  calibrating = false;
  const events = groupEvents(calFrames);
  if (events.length < 2) {
    say("heard " + events.length + " — squeeze it at least twice, closer to the mic");
    calFrames = [];
    render();
    return;
  }
  const acc = new Float32Array(nbins);
  let used = 0;
  for (const ev of events) {
    const peak = ev.reduce((a, b) => (b.energy > a.energy ? b : a));
    const u = normalise(peak.mag);
    if (!u) continue;
    for (let i = 0; i < nbins; i++) acc[i] += u[i];
    used++;
  }
  template = normalise(acc);
  calFrames = [];
  save();
  say("learned your duck from " + used + " squeezes");
  render();
}

function startCalibration() {
  if (!armed) { say("turn the mic on first"); render(); return; }
  calibrating = true;
  calFrames = [];
  calUntil = now() + 6;
  charge = 0;
  say("squeeze it, three times");
  render();
}

function save() {
  try {
    if (template) localStorage.setItem(STORE_KEY, JSON.stringify({
      rate: ctx.sampleRate, lo, hi, v: Array.from(template, (x) => +x.toFixed(5)),
    }));
  } catch (e) { /* private mode; not worth complaining about */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    // Bin layout depends on the sample rate, so a template from a different device
    // would be nonsense here.
    if (d.rate !== ctx.sampleRate || d.v.length !== nbins) return;
    template = normalise(Float32Array.from(d.v));
    say("remembered your duck");
  } catch (e) { /* ignore */ }
}

function forget() {
  template = null;
  try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  say("forgotten");
  render();
}

/* ---------- mic ---------- */

async function arm() {
  if (armed) return;
  try {
    // No processing: AGC and noise suppression both chew up exactly the short
    // broadband transient this is trying to detect.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    say("no mic — " + (e && e.name ? e.name : "refused"));
    render();
    return;
  }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  analyser = ctx.createAnalyser();
  analyser.fftSize = FFT;
  analyser.smoothingTimeConstant = 0;   // we want transients, not a smoothed average
  src.connect(analyser);
  freq = new Float32Array(analyser.frequencyBinCount);

  lo = binOf(BAND_LO); hi = binOf(BAND_HI);
  nbins = hi - lo;
  subLo = clamp(binOf(FALLBACK_LO) - lo, 0, nbins);
  subHi = clamp(binOf(FALLBACK_HI) - lo, 0, nbins);
  mag = new Float32Array(nbins);
  prevMag = null;
  floorEnergy = 0;

  armed = true;
  load();
  say("listening.");
  render();
}

function disarm() {
  armed = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (ctx) ctx.close();
  stream = null; ctx = null; analyser = null;
  say("mic off");
  render();
}

/* ---------- gate ---------- */

/* What harmonium.js multiplies its output by. One squeeze should be immediately
   audible rather than a whisper, so the curve steps up the moment anything lands and
   swells from there; below the floor it is hard zero, because the instrument being
   properly silent is the whole point. */
const FLOOR = 0.04;
function gate() {
  if (!locked) return 1;
  if (charge < FLOOR) return 0;
  return 0.15 + 0.85 * Math.pow(charge, 0.7);
}

function tick() {
  const t = now();
  const dt = lastTick ? Math.min(0.25, t - lastTick) : 0;
  lastTick = t;
  charge *= Math.exp(-dt / TAU);
  if (charge < 0.0005) charge = 0;
  if (armed && analyser) detect();
  render();
}

/* ---------- talking back ---------- */

/* Every line is literally about squeezing a rubber duck, which is the whole trick —
   they read as something else only because of what the machine is asking you to do. */
const IDLE = [
  "squeeze it.",
  "it won't squeeze itself.",
  "go on then.",
  "nothing. harder.",
];
const FADING = [
  "again.",
  "don't stop now.",
  "keep squeezing.",
  "going limp.",
  "harder.",
];
// Armed, calibrated, and nothing has happened for a good while.
const GIVEN_UP = [
  "you've given up.",
  "still holding it, still not squeezing.",
  "we can wait all day.",
  "cold duck.",
];
const IDLE_SECONDS = 20;

let lastHitAt = 0;

function say(msg) { if (msg) { note = msg; noteUntil = now() + 2.2; } }

function status() {
  const t = now();
  if (!locked) return "unlocked — playing for free";
  if (calibrating) return note;
  // A fresh message outranks the idle states, so "turn the mic on first" is not
  // swallowed by the generic "mic off" it would otherwise fall through to.
  if (t < noteUntil && note) return note;
  if (!armed) return "mic off";
  if (!template) return "uncalibrated — using a generic squeak";
  const rot = Math.floor(t / 2.6);
  if (charge < FLOOR) {
    // Nothing heard in a long time reads as having stopped trying, not as waiting.
    const quiet = lastHitAt && t - lastHitAt > IDLE_SECONDS;
    const bank = quiet ? GIVEN_UP : IDLE;
    return bank[rot % bank.length];
  }
  if (charge < 0.3) return FADING[rot % FADING.length];
  if (charge > 0.75) return "good duck.";
  return "playing.";
}

/* ---------- ui ---------- */

const $ = (id) => document.getElementById(id);
let scope = null, sctx = null, frames = 0;

function css(name, fallback) {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

/* Live spectrum with the learned template drawn over it, so when it will not trigger on
   the day you can see whether the duck is missing the template or just too quiet. */
function drawScope() {
  if (!sctx || !unit) return;
  const w = scope.width = scope.clientWidth * devicePixelRatio;
  const h = scope.height = 90 * devicePixelRatio;
  sctx.clearRect(0, 0, w, h);

  let peak = 0;
  for (let i = 0; i < nbins; i++) peak = Math.max(peak, unit[i]);
  if (peak < 1e-6) peak = 1;

  sctx.fillStyle = css("--series-1-soft", "rgba(42,120,214,0.14)");
  const bw = w / nbins;
  for (let i = 0; i < nbins; i++) {
    const barH = (unit[i] / peak) * h;
    sctx.fillRect(i * bw, h - barH, Math.max(1, bw), barH);
  }

  if (template) {
    let tp = 0;
    for (let i = 0; i < nbins; i++) tp = Math.max(tp, template[i]);
    sctx.strokeStyle = css("--series-2", "#eb6834");
    sctx.lineWidth = 1.5 * devicePixelRatio;
    sctx.beginPath();
    for (let i = 0; i < nbins; i++) {
      const y = h - (template[i] / tp) * h;
      i ? sctx.lineTo(i * bw, y) : sctx.moveTo(i * bw, y);
    }
    sctx.stroke();
  }
}

function render() {
  const bar = $("duckBar");
  if (bar) bar.style.width = (charge * 100).toFixed(1) + "%";
  const val = $("duckVal");
  if (val) val.textContent = Math.round(charge * 100) + "%";
  const st = $("duckStatus");
  if (st) {
    st.textContent = status();
    st.classList.toggle("bad", locked && charge < FLOOR);
  }
  const m = $("duckMatch");
  if (m) m.textContent = template ? (lastSim * 100).toFixed(0) + "%" : "n/a";
  const c = $("duckHits");
  if (c) c.textContent = hits;
  const btn = $("duckMic");
  if (btn) { btn.textContent = armed ? "Mic on" : "Mic"; btn.classList.toggle("on", armed); }
  if (++frames % 2 === 0) drawScope();
}

function init() {
  scope = $("duckScope");
  if (scope) sctx = scope.getContext("2d");

  const lock = $("duckLock");
  if (!navigator.mediaDevices) {
    locked = false;
    if (lock) { lock.checked = false; lock.disabled = true; }
  } else if (lock) {
    lock.checked = locked;
    lock.addEventListener("change", (e) => { locked = e.target.checked; render(); });
  }

  const mic = $("duckMic");
  if (mic) mic.addEventListener("click", () => (armed ? disarm() : arm()));
  const cal = $("duckCal");
  if (cal) cal.addEventListener("click", startCalibration);
  const fg = $("duckForget");
  if (fg) fg.addEventListener("click", forget);

  setInterval(tick, 16);
  render();
}

window.Duck = {
  init, gate, arm, disarm, calibrate: startCalibration, forget,
  // Debug hook: charge without a duck.
  squeeze: (n) => { charge = clamp(charge + PER_SQUEEZE * (n || 1), 0, 1); hits++; lastHitAt = now(); say("quack"); render(); return charge; },
  tune: (o) => {
    if (o.tau !== undefined) TAU = o.tau;
    if (o.perSqueeze !== undefined) PER_SQUEEZE = o.perSqueeze;
    if (o.sim !== undefined) SIM_MIN = o.sim;
    if (o.energy !== undefined) ENERGY_MULT = o.energy;
    if (o.flux !== undefined) FLUX_MIN = o.flux;
    return { TAU, PER_SQUEEZE, SIM_MIN, ENERGY_MULT, FLUX_MIN };
  },
  state: () => ({
    charge, locked, armed, gate: gate(), hits, calibrated: !!template,
    sim: lastSim, flux: lastFlux, energy: lastEnergy, floor: floorEnergy,
  }),
};
})();
