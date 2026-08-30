# lidangle

Reads the MacBook lid angle sensor and shows it on a live dashboard.

## The sensor

Apple ships a real hinge angle sensor on recent MacBooks. It appears as an HID
device — vendor `0x05AC`, product `0x8104`, usage page `0x20` ("Sensors"), usage
`0x8A` ("Orientation: Compound"). Its report descriptor declares report ID 1 as a
single 9-bit field with logical *and* physical range `0...360`, so the raw value is
the angle in degrees with no scaling. Closed is 0; this machine's hinge tops out
around 130-135.

## Setup

Needs macOS (the sensor, `swiftc`, and the system voices) and Python 3.

The sampled voices are not in the repo — they are rendered from the macOS system
voices, which are Apple's and not ours to redistribute. To enable the **Sampled**
voice source, generate them locally:

    python3 make-voices.py   # writes voices/*.wav + manifest.json (~450 KB)

Everything else — the reeds, the formant voice, the backing track — works without it.

## Use

    ./dashboard          # build if needed, serve on :8787, open the browser
    ./lidangle           # print the angle once, e.g. "124"
    ./lidangle --json    # {"angle":124,"t":1788028280.68}
    ./lidangle --watch   # stream JSON lines at 20 Hz

Set `LIDANGLE_PORT` to serve somewhere other than 8787.

## The harmonium

The dashboard doubles as a playable harmonium, which is a fitting instrument for a
hinge: a real harmonium makes no sound on its own — one hand pumps a bellows for air
while the other stops keys. The lid does both jobs.

- **How far open** picks the note. The 20°–133° travel is divided into scale steps,
  labelled in sargam. Notes glide rather than retrigger, since free reeds have no
  attack transient and players slide between notes anyway.
- **Moving the lid** pumps the bellows. Air accumulates with travel and drains with a
  ~1.15 s time constant, so holding still fades the sound out in about two seconds.
  *Sustain* pins the bellows open if you'd rather just play with the angle.
- **Drone** adds the usual Sa + Pa underneath.

Two voice sources are available. **Formant** is the synthesis described below.
**Sampled** plays real vowels rendered from the macOS system voices — Daniel (en-GB),
Samantha (en-US), Rishi (en-IN), Kyoko (ja-JP), Tingting (zh-CN) — looped over their
steady middle and resampled onto the note. Those are spoken at 104-294 Hz while the
reeds play C4-C6, so the rate is octave-folded the way a sampler does it: the voice
follows the pitch class and picks whatever octave keeps it in a natural register,
which holds the formant shift to about a fifth instead of demanding a 10x rate.

`make-voices.py` renders each vowel, finds its steady window from an RMS envelope, and
detects f0 with YIN's cumulative mean normalised difference — plain autocorrelation is
biased toward short lags and kept reporting harmonics an octave up.

The voice is additive: a free-reed harmonic spectrum, two oscillators per bank detuned
a few cents so the banks beat against each other the way real ones do, a lowpass that
opens with air pressure, a little bellows hiss, and a slow tremolo. Five ragas are
included — Bhupali, Yaman, Bhairav, Kafi, Darbari.

Audio needs a click to start (browsers require a gesture) and parks itself when the
tab is hidden.

## Voice

A wordless singing voice can be layered over the reeds, built by formant synthesis —
a sawtooth glottal source through a bank of parallel bandpass filters. The filter
positions are the formants, and formant positions are what the ear reads as a vowel.

**The lid is the mouth.** Nearly shut sings a closed vowel (*oo*), wide open sings an
open one (*ah*), and the formants glide continuously between, so the vowel opens as
the laptop does. Each language's vowels are listed closed-first and F1 rises strictly
along the row — which is why the mid vowel is taken in its open-mid realization, since
a close-mid /e/ sits below /o/ in F1 and would make the mouth briefly close again.

What differs per language:

| | signature |
|---|---|
| Japanese | compressed (unrounded) /u/, so F2 sits far above a European /u/; pure, clipped vowels with almost no glide |
| Mandarin | back unrounded [ɤ]; each note gets one of the four tone contours in turn |
| Indian | meend — notes joined by a slide rather than a step — plus a wide gamak oscillation |
| British (RP) | backer "ah", so F2 drops |
| American (GA) | r-colouring collapses F3 toward F2 |

The formant tables are approximations of published averages, not measurements: enough
to colour a vowel recognisably, not a phonetics claim.

## Backing track

Paste a YouTube link and the track plays underneath while you play the hinge on top.

The track runs in YouTube's own iframe, which is cross-origin — its audio cannot be
pulled into the Web Audio graph, so there are no effects on it and no analysis of it.
The two simply mix at the output. Transport and volume are reachable through the
IFrame API, which is enough for **Duck under reeds**: the track's volume drops as the
bellows fill, so the harmonium sits on top instead of fighting the mix.

Because a backing track has its own key, the **Sa** selector transposes the whole
instrument — reeds and drone — to match it. A tanpura drone or a tabla loop makes a
good bed. The last link you used is remembered in `localStorage`.

Some videos have embedding disabled by their owner; the player reports that rather
than failing silently, and you'll need a different track.

## Files

- `lidangle.swift` — the sensor reader; build with `swiftc -O lidangle.swift -o lidangle`
- `server.py` — serves the page, streams readings over SSE from one shared reader
- `index.html` — the dashboard
- `harmonium.js` — the reed synthesis and the hinge-to-note mapping
- `voice.js` — formant vocal synthesis, per-language vowel tables
- `backing.js` — the YouTube backing track
- `dashboard` — launcher
