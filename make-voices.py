#!/usr/bin/env python3
"""Render sustained vowels with the macOS system voices and analyse them for playback.

These are the voices already installed on this Mac, so nothing is downloaded and
nothing of unknown provenance ends up in the project. Apple licenses them for use on
the machine: generating audio locally for your own use is ordinary, but the rendered
files are derived from Apple's voices, so don't redistribute them with the project.

For each vowel this works out two things the browser needs:
  * f0  — the voice's natural pitch, so playbackRate can be set to hit a wanted note
  * a loop window over the steady middle of the vowel, skipping attack and release,
    so the note can be held indefinitely

Re-run after editing VOICES or VOWELS:  python3 make-voices.py
"""

import array
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import wave

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices")
RATE = 22050

# accent key -> (say voice, {vowel: text to speak})
VOICES = {
    "british":  ("Daniel",   {"u": "ooh", "o": "oh", "e": "eh", "a": "ah"}),
    "american": ("Samantha", {"u": "ooh", "o": "oh", "e": "eh", "a": "ah"}),
    "indian":   ("Rishi",    {"u": "ooh", "o": "oh", "e": "eh", "a": "ah"}),
    "japanese": ("Kyoko",    {"u": "うー", "o": "おー", "e": "えー", "a": "あー"}),
    "mandarin": ("Tingting", {"u": "乌",   "o": "喔",   "e": "呃",   "a": "啊"}),
}
VOWEL_ORDER = ["u", "o", "e", "a"]   # closed -> open, matching the formant tables


def render(voice, text, path):
    aiff = path + ".aiff"
    subprocess.run(["say", "-v", voice, "-r", "90", "-o", aiff, text], check=True)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{RATE}", "-c", "1", aiff, path],
                   check=True, stdout=subprocess.DEVNULL)
    os.remove(aiff)


def read_samples(path):
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2 and w.getnchannels() == 1, path
        raw = w.readframes(w.getnframes())
        rate = w.getframerate()
    a = array.array("h")
    a.frombytes(raw)
    return [s / 32768.0 for s in a], rate


def steady_window(samples, rate):
    """Longest run of frames loud enough to be the held part of the vowel."""
    fr = max(1, rate // 100)                       # 10 ms frames
    rms = []
    for i in range(0, len(samples) - fr, fr):
        chunk = samples[i:i + fr]
        rms.append(math.sqrt(sum(x * x for x in chunk) / len(chunk)))
    if not rms:
        return 0.0, len(samples) / rate
    peak = max(rms)
    if peak <= 0:
        return 0.0, len(samples) / rate
    loud = [r >= peak * 0.40 for r in rms]
    best_i = best_n = cur_i = cur_n = 0
    for i, v in enumerate(loud):
        if v:
            if cur_n == 0:
                cur_i = i
            cur_n += 1
            if cur_n > best_n:
                best_i, best_n = cur_i, cur_n
        else:
            cur_n = 0
    start, end = best_i * fr, (best_i + best_n) * fr
    # Trim the attack and release shoulders off the run.
    pad = int((end - start) * 0.18)
    start, end = start + pad, end - pad
    if end - start < rate * 0.04:                  # too short to loop; use the whole run
        start, end = best_i * fr, (best_i + best_n) * fr
    return start / rate, end / rate


def detect_f0(samples, rate, t0, t1):
    """Pitch by YIN's cumulative mean normalised difference.

    Plain autocorrelation is biased toward short lags and so tends to report a
    harmonic instead of the fundamental — an octave error. YIN normalises each
    candidate against the running mean of all shorter lags, which removes that bias,
    and then takes the first lag under an absolute threshold rather than the global
    best, which is what keeps it on the fundamental.
    """
    i0, i1 = int(t0 * rate), int(t1 * rate)
    mid = (i0 + i1) // 2
    half = min(2048, i1 - i0) // 2
    # Clamp to the array: a window centred near either end would otherwise come back
    # short, and the lag loop would index past it.
    win = samples[max(0, mid - half): min(len(samples), mid + half)]
    n = len(win)
    if n < 512:
        return None

    lo, hi = int(rate / 400), min(int(rate / 70), n // 2)
    if hi <= lo:
        return None

    diff = [0.0] * (hi + 1)
    for lag in range(lo, hi + 1):
        total = 0.0
        for i in range(n - hi):
            d = win[i] - win[i + lag]
            total += d * d
        diff[lag] = total

    # Cumulative mean normalisation.
    cmnd = [1.0] * (hi + 1)
    running = 0.0
    for lag in range(lo, hi + 1):
        running += diff[lag]
        cmnd[lag] = diff[lag] * (lag - lo + 1) / running if running > 0 else 1.0

    best = min(range(lo, hi + 1), key=lambda l: cmnd[l])
    for lag in range(lo, hi + 1):
        if cmnd[lag] < 0.15:
            best = lag
            break
    return round(rate / best, 2) if best else None


def harmonise(vowels):
    """Snap octave outliers to the speaker's own pitch.

    All four vowels come from one voice, so their f0 should agree closely. Anything
    sitting near a 2x or 0.5x ratio to the median is an octave slip, not the speaker
    suddenly changing register.
    """
    found = [v["f0"] for v in vowels.values() if v["f0"]]
    if not found:
        return
    found.sort()
    median = found[len(found) // 2]
    for v in vowels.values():
        f = v["f0"]
        if not f:
            v["f0"] = median
            continue
        for mult in (0.25, 0.5, 2.0, 4.0):
            if abs(f * mult - median) < abs(f - median):
                f = f * mult
        if abs(f - median) / median > 0.35:   # still nowhere near: trust the speaker
            f = median
        v["f0"] = round(f, 2)


def main():
    if not shutil.which("say") or not shutil.which("afconvert"):
        sys.exit("needs macOS `say` and `afconvert`")
    os.makedirs(OUT, exist_ok=True)
    manifest = {}
    for accent, (voice, vowels) in VOICES.items():
        manifest[accent] = {"voice": voice, "vowels": {}}
        for v in VOWEL_ORDER:
            name = f"{accent}-{v}.wav"
            path = os.path.join(OUT, name)
            render(voice, vowels[v], path)
            samples, rate = read_samples(path)
            t0, t1 = steady_window(samples, rate)
            f0 = detect_f0(samples, rate, t0, t1)
            manifest[accent]["vowels"][v] = {
                "file": name,
                "f0": f0,
                "loopStart": round(t0, 4),
                "loopEnd": round(t1, 4),
                "duration": round(len(samples) / rate, 4),
            }
        harmonise(manifest[accent]["vowels"])
        for v in VOWEL_ORDER:
            d = manifest[accent]["vowels"][v]
            print(f"{accent:9s} {v}  {voice:9s} f0={d['f0']:>7}Hz  "
                  f"loop {d['loopStart']:.3f}-{d['loopEnd']:.3f}s of {d['duration']:.3f}s")
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump({"order": VOWEL_ORDER, "accents": manifest}, f, indent=2)
    print(f"\nwrote {OUT}/manifest.json")


if __name__ == "__main__":
    main()
