/* voice.js — a wordless singing voice layered over the reeds.
 *
 * Built by formant synthesis, which is how a voice actually works: the vocal folds
 * make a buzzy, harmonically rich tone, and the shape of the mouth above them boosts
 * a few narrow frequency bands. Those bands are the formants, and their positions are
 * what your ear reads as a vowel. So: a sawtooth glottal source into a bank of
 * parallel bandpass filters, and moving the filters moves the vowel.
 *
 * The lid is the mouth. A nearly shut lid sings a closed vowel (oo); wide open sings
 * an open one (ah); in between the formants glide continuously through the vowel
 * space, so the vowel opens as the laptop does.
 *
 * The per-language tables are approximations of published formant averages, not
 * measurements — enough to colour the vowel recognisably, not a phonetics claim.
 */
(function () {
"use strict";

/* Vowels are listed most closed first, so index order is also mouth aperture, and
   F1 — which tracks how open the mouth is — rises strictly along each row. That
   constraint is why the mid vowel is taken in its open-mid realization ([e̞]/[ɛ]/[ɤ])
   rather than close-mid: a close-mid /e/ sits *below* /o/ in F1, which would make the
   mouth briefly close again as the lid opened. [F1, F2, F3] in Hz. */
const LANGS = {
  japanese: {
    label: "Japanese",
    // The Japanese /u/ is compressed rather than rounded, which lifts F2 well above
    // the back /u/ of most European languages — the most audible single difference.
    vowels: [["u", 300, 1300, 2200], ["o", 500, 900, 2400], ["e", 600, 1900, 2500], ["a", 750, 1150, 2400]],
    glide: 0.02,        // pure, clipped vowels; almost no glide between them
    vibrato: 10,
    gamak: 0,
    tones: null,
  },
  mandarin: {
    label: "Mandarin",
    // /e/ here is the back unrounded [ɤ], which sits far from a European "eh".
    vowels: [["u", 310, 750, 2200], ["o", 520, 900, 2350], ["e", 560, 1300, 2400], ["a", 800, 1200, 2500]],
    glide: 0.05,
    vibrato: 12,
    gamak: 0,
    // The four tones, as cent offsets across the first part of a note.
    tones: [
      [0, 0],            // 1: high level
      [-180, 0],         // 2: rising
      [-100, -300, 0],   // 3: dipping
      [150, -120],       // 4: falling
    ],
  },
  indian: {
    label: "Indian",
    vowels: [["u", 330, 900, 2300], ["o", 480, 900, 2350], ["e", 560, 2000, 2600], ["a", 700, 1200, 2450]],
    glide: 0.18,        // meend: notes are joined by a slide, not a step
    vibrato: 14,
    gamak: 45,          // gamak: a wide oscillation around the note
    tones: null,
  },
  british: {
    label: "British (RP)",
    // RP's "ah" is further back than the American one, so F2 drops.
    vowels: [["u", 320, 1400, 2200], ["o", 420, 750, 2400], ["e", 560, 1800, 2500], ["a", 680, 1050, 2400]],
    glide: 0.06,
    vibrato: 12,
    gamak: 0,
    tones: null,
    rhotic: false,
  },
  american: {
    label: "American (GA)",
    vowels: [["u", 330, 1500, 2200], ["o", 570, 900, 2450], ["e", 610, 1850, 2550], ["a", 750, 1200, 2500]],
    glide: 0.06,
    vibrato: 12,
    gamak: 0,
    tones: null,
    rhotic: true,       // r-colouring pulls F3 down hard; the giveaway of a US vowel
  },
};

const FORMANT_GAIN = [1.0, 0.45, 0.25, 0.12];
const FORMANT_BW   = [70, 100, 130, 160];
const SINGERS_FORMANT = 2900;   // the "ring" that carries a trained voice over a band

let ctx = null, out = null;
let glottis = null, breath = null, formants = [], voiceGain = null;
let formantOut = null, sampleOut = null;
let source = "formant";           // "formant" (synthesised) or "sampled" (macOS voices)
let manifest = null, sampleCache = {}, sampleNodes = [];
let vibratoDepth = null, gamakDepth = null;
let lang = LANGS.japanese, langKey = "japanese";
let enabled = false, volume = 0.6, level = 0, aperture = 0;
let baseFreq = 261.626, toneIdx = 0, currentVowel = "u";

const lerp = (a, b, t) => a + (b - a) * t;

function attach(audioCtx, destination) {
  ctx = audioCtx;
  out = destination;

  voiceGain = ctx.createGain();
  voiceGain.gain.value = 0;
  voiceGain.connect(out);

  // Two paths into the same voice bus: synthesised formants, and real recorded
  // vowels. Only one is audible at a time.
  formantOut = ctx.createGain();
  formantOut.gain.value = source === "formant" ? 1 : 0;
  formantOut.connect(voiceGain);
  sampleOut = ctx.createGain();
  sampleOut.gain.value = source === "sampled" ? 1 : 0;
  sampleOut.connect(voiceGain);

  // Glottal source. A sawtooth is buzzy in roughly the right way; the lowpass
  // gives it the rolloff a real glottal pulse has instead of a raw edge.
  glottis = ctx.createOscillator();
  glottis.type = "sawtooth";
  glottis.frequency.value = baseFreq;
  const soften = ctx.createBiquadFilter();
  soften.type = "lowpass";
  soften.frequency.value = 5000;
  glottis.connect(soften);

  // A little aspiration through the same filters keeps it from sounding like a synth.
  const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = nb; noise.loop = true;
  breath = ctx.createGain();
  breath.gain.value = 0.06;
  noise.connect(breath);

  formants = [];
  for (let i = 0; i < 4; i++) {
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 500;
    bp.Q.value = 500 / FORMANT_BW[i];
    const g = ctx.createGain();
    g.gain.value = FORMANT_GAIN[i];
    soften.connect(bp);
    breath.connect(bp);
    bp.connect(g).connect(formantOut);
    formants.push(bp);
  }

  // Vibrato and gamak both ride on detune, in cents, so they add to the pitch.
  const vib = ctx.createOscillator();
  vib.frequency.value = 5.4;
  vibratoDepth = ctx.createGain();
  vibratoDepth.gain.value = 0;
  vib.connect(vibratoDepth).connect(glottis.detune);
  vib.start();

  const gam = ctx.createOscillator();
  gam.frequency.value = 6.2;
  gamakDepth = ctx.createGain();
  gamakDepth.gain.value = 0;
  gam.connect(gamakDepth).connect(glottis.detune);
  gam.start();

  glottis.start();
  noise.start();
  applyLangParams();
}

function applyLangParams() {
  if (!ctx) return;
  const when = ctx.currentTime;
  vibratoDepth.gain.setTargetAtTime(lang.vibrato, when, 0.1);
  gamakDepth.gain.setTargetAtTime(lang.gamak, when, 0.1);
}

/* Move the formants to the vowel that this much mouth-opening implies. */
function setAperture(t) {
  aperture = Math.min(1, Math.max(0, t));
  if (!ctx) return;
  const vs = lang.vowels;
  const pos = aperture * (vs.length - 1);
  const i = Math.min(vs.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = vs[i], b = vs[i + 1];
  currentVowel = f < 0.5 ? a[0] : b[0];

  const when = ctx.currentTime;
  for (let k = 0; k < 3; k++) {
    let hz = lerp(a[k + 1], b[k + 1], f);
    // r-colouring collapses F3 toward F2; it is what makes a vowel sound American.
    if (lang.rhotic && k === 2) hz = lerp(hz, 1700, 0.55);
    formants[k].frequency.setTargetAtTime(hz, when, 0.04);
    formants[k].Q.setTargetAtTime(hz / FORMANT_BW[k], when, 0.04);
  }
  formants[3].frequency.setTargetAtTime(SINGERS_FORMANT, when, 0.04);
  updateSampleGains();
}

/* Called when the hinge picks a new note. */
function setNote(freq) {
  baseFreq = freq;
  if (!ctx) return;
  const when = ctx.currentTime;
  // Indian meend slides into the note; Japanese steps onto it almost instantly.
  glottis.frequency.setTargetAtTime(freq, when, lang.glide);
  for (const n of sampleNodes) {
    n.src.playbackRate.setTargetAtTime(foldRate(freq, n.f0), when, lang.glide);
  }

  if (lang.tones) {
    // Walk the four tones in turn, drawn as a cent contour over the note's opening.
    const contour = lang.tones[toneIdx % lang.tones.length];
    toneIdx++;
    glottis.detune.cancelScheduledValues(when);
    glottis.detune.setValueAtTime(contour[0], when);
    const span = 0.36 / Math.max(1, contour.length - 1);
    for (let i = 1; i < contour.length; i++) {
      glottis.detune.linearRampToValueAtTime(contour[i], when + span * i);
    }
  }
}

function setLevel(p) {
  level = p;
  if (!ctx) return;
  // Voices need more breath than reeds to speak at all, hence the steeper curve.
  const target = enabled ? Math.pow(p, 1.6) * 0.5 * volume : 0;
  voiceGain.gain.setTargetAtTime(target, ctx.currentTime, 0.07);
  if (breath) breath.gain.setTargetAtTime(0.03 + p * 0.05, ctx.currentTime, 0.07);
}

/* ---- sampled voices ---------------------------------------------------------
   Real vowels rendered from the macOS system voices. They are spoken in a normal
   register (104-294 Hz) while the reeds play C4-C6, so resampling straight onto the
   melody would demand playback rates up to 10x — unusable. Instead the rate is
   octave-folded, the way a sampler does it: the voice follows the pitch class of the
   note and picks whatever octave keeps it in a natural register. Formants still shift
   with the rate, but folding holds that within about a fifth. */

function foldRate(target, f0) {
  let r = target / f0;
  while (r > 1.5) r /= 2;
  while (r < 0.7) r *= 2;
  return r;
}

async function loadAccent(key) {
  if (sampleCache[key]) return sampleCache[key];
  if (!manifest) manifest = await (await fetch("voices/manifest.json")).json();
  const spec = manifest.accents[key];
  if (!spec) throw new Error("no samples for " + key);
  const bank = {};
  await Promise.all(manifest.order.map(async (v) => {
    const d = spec.vowels[v];
    const buf = await (await fetch("voices/" + d.file)).arrayBuffer();
    bank[v] = { ...d, buffer: await ctx.decodeAudioData(buf) };
  }));
  sampleCache[key] = { order: manifest.order, bank, voice: spec.voice };
  return sampleCache[key];
}

function stopSamples() {
  for (const n of sampleNodes) { try { n.src.stop(); } catch (e) { /* already stopped */ } }
  sampleNodes = [];
}

function startSamples(loaded) {
  stopSamples();
  for (const v of loaded.order) {
    const d = loaded.bank[v];
    const src = ctx.createBufferSource();
    src.buffer = d.buffer;
    src.loop = true;
    src.loopStart = d.loopStart;
    src.loopEnd = d.loopEnd;
    src.playbackRate.value = foldRate(baseFreq, d.f0);
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(sampleOut);
    src.start(0, d.loopStart);
    sampleNodes.push({ src, gain: g, f0: d.f0 });
  }
  setAperture(aperture);
}

/* Equal-power crossfade between the two vowels either side of the mouth opening. */
function updateSampleGains() {
  if (!sampleNodes.length) return;
  const pos = aperture * (sampleNodes.length - 1);
  const i = Math.min(sampleNodes.length - 2, Math.floor(pos));
  const f = pos - i;
  const when = ctx.currentTime;
  sampleNodes.forEach((n, k) => {
    let g = 0;
    if (k === i) g = Math.sqrt(1 - f);
    else if (k === i + 1) g = Math.sqrt(f);
    n.gain.gain.setTargetAtTime(g, when, 0.04);
  });
}

function setSource(mode) {
  source = mode === "sampled" ? "sampled" : "formant";
  if (!ctx) return;
  const when = ctx.currentTime;
  formantOut.gain.setTargetAtTime(source === "formant" ? 1 : 0, when, 0.05);
  sampleOut.gain.setTargetAtTime(source === "sampled" ? 1 : 0, when, 0.05);
  if (source === "sampled") {
    const key = langKey;
    loadAccent(key)
      .then((l) => { if (langKey === key && source === "sampled") startSamples(l); })
      .catch((e) => console.warn("voice samples:", e.message));
  } else {
    stopSamples();
  }
}

function setLang(key) {
  lang = LANGS[key] || LANGS.japanese;
  langKey = LANGS[key] ? key : "japanese";
  toneIdx = 0;
  applyLangParams();
  setAperture(aperture);
  if (ctx) glottis.frequency.setTargetAtTime(baseFreq, ctx.currentTime, lang.glide);
  if (ctx && source === "sampled") setSource("sampled");   // swap in the new accent's samples
}

window.Voice = {
  LANGS,
  attach, setNote, setAperture, setLevel, setLang, setSource,
  setEnabled: (v) => { enabled = v; if (!v) setLevel(0); },
  setVolume: (v) => { volume = v; },
  isEnabled: () => enabled,
  vowel: () => currentVowel,
  langLabel: () => lang.label,
};
})();
