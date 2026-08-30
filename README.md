# Weak Independent Harmonium

> **Every token costs you a breath.**

Built at [What the Hack!](https://wth.devfolio.co) — Bengaluru, 30 August 2026.
[Submission](https://devfolio.co/projects/weak-independent-harmonium-e911) · by Vee Sesh.

Your laptop lid is now a harmonium.

## What it does

This turns Claude Code into a tool that requires continuous physical engagement. It
reads a MacBook's hinge-angle sensor and converts lid movement into musical notes while
simultaneously controlling Claude's execution.

The core mechanic: **Claude only runs while the lid is actively moving.** When movement
stops, the supervisor sends `SIGSTOP` and Claude pauses mid-task — mid-token,
mid-tool-call. Resuming lid movement sends `SIGCONT` and execution continues from
exactly where it halted.

The lid does two jobs at once, the way a harmonium player's two hands do. How far it is
open picks the note, in sargam, across five ragas. *Moving* it pumps the bellows. The
same air that makes the reeds sound is the air Claude is running on, so the note you
hear is a live readout of how much longer the model has to live.

## The problem it solves

Claude Code normally runs autonomously once prompted — you can walk away and leave the
MacBook untouched. This inverts that workflow. You must actively pump the lid like a
bellows to sustain Claude's operation, which eliminates passive automation and
introduces a humorous constraint: **productivity now requires exhaustion.**

A harmonium already works this way and always has. It makes no sound on its own — one
hand pumps air while the other stops keys — so the instrument is only ever as alive as
the person operating it. Applying that to a language model is the entire idea.

## Key challenges

**Signal management.** Early iterations used a single movement threshold, so when the
lid hovered at the boundary Claude received rapid `SIGSTOP`/`SIGCONT` cycles — dozens a
second, which wedges the terminal rather than pausing it. Fixed with hysteresis:
separate thresholds for pausing and resuming.

**Process supervision.** If the supervisor died while Claude was stopped, the tree froze
permanently — a suspended process is unkillable by ordinary means and the terminal never
comes back. The supervisor now always sends `SIGCONT` before terminating, down every
exit path including Ctrl-C. It also refuses to be stopped itself: sharing a process
group with the child meant one Ctrl-Z stopped Claude *and* the only thing that could
resume it. The child now gets its own process group and the terminal foreground.

**Code quality.** A dead branch survived two reviews because the logic checked whether a
template existed *before* the line that loads it, so the condition was never once true.

**Browser autoplay.** Web Audio will not make a sound without a user gesture, so the
dashboard launches its own browser window against a throwaway profile with the autoplay
policy relaxed — which keeps that relaxation off the browser you actually use.

**Audio processing.** Vowel formant ordering had to be corrected so the mouth opens
monotonically with the lid, and pitch detection moved to YIN's cumulative mean
normalised difference after plain autocorrelation kept reporting harmonics an octave up.

## Quick start

    ./bellows                     # sandboxed Claude, gated on the hinge, reeds playing
    ./bellows --tau 2 --speak     # demo mode: freezes every few seconds, nags out loud
    ./bellows --dry               # just the meter, no Claude
    ./bellows --thaw              # resume anything a previous run left frozen

Everything runs against a sandboxed `CLAUDE_CONFIG_DIR`, so it cannot touch the
credentials, history or settings of the Claude you actually use. The first run will ask
you to authenticate; that login is only for the sandbox.

The rest of this file is how it works.

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
    ./bellows            # run Claude Code, gated on pumping the lid
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

## The duck

A rubber duck is a bellows with a free reed in it. Squeeze, and air is forced past a
thin tongue that flaps and makes a tone — which is exactly, mechanically, what a
harmonium is. A duck is a one-note harmonium. So the small one powers the big one: the
reeds stay silent until you squeeze, and you are pumping a real reed to drive a
synthesised one.

Permission drains with a ~8 s time constant, against the bellows' 1.15 s. The lid is a
fast continuous control and the duck is a slow intermittent one, so anything longer than
a phrase means squeezing on a steady beat with one hand while the other works the hinge.
Neither alone produces sound.

**Wear headphones.** Otherwise the mic hears the reeds through the speakers and the
instrument starts feeding itself. The onset test below mostly prevents it — reeds are
sustained and squeaks are not, and they sit an octave or two apart — but headphones are
the actual fix.

### Detection

Not speech recognition; audio event detection. A squeak is a short broadband transient
somewhere around 1–4 kHz, but the exact pitch depends entirely on the size of the duck,
so nothing is hardcoded. A frame counts as a squeak only if it clears three independent
tests:

| | test | what it rejects |
|---|---|---|
| **loud** | band energy over an adaptive noise floor | a quiet room and a loud one both work without a knob |
| **sudden** | positive spectral flux — an onset | a sustained tone at the same pitch: a voice, a hum, the harmonium's own output |
| **shaped** | cosine similarity against the learned template | anything percussive that isn't your duck |

The flux is rectified, so only rises count and a decaying tone contributes nothing —
that is what makes it an onset detector rather than a level meter. The noise floor is an
EMA that updates *only while nothing is happening*, since otherwise a long squeeze would
raise the very threshold it needs to clear. Similarity is level invariant because both
vectors are L2 normalised, so a squeeze from across the room matches a squeeze into the
mic.

**Teach it your duck** listens for six seconds. Every loud onset frame is kept, then
grouped into events by time gaps — one squeeze usually gives two, a push and a release,
and both are equally the duck. The peak frame of each event is normalised and the events
averaged, so the template describes the duck's shape rather than any one squeeze's
loudness. It is saved to `localStorage` against the sample rate it was captured at, so
you calibrate once at your table and it survives a reload on stage.

The analysis band is fixed at 700–7000 Hz whatever the calibration state, so a saved
template always lines up with a freshly opened mic. Uncalibrated it falls back to
loud-and-sudden with those two tests narrowed to 1–4 kHz — with no template to match
against, a clap or a keyboard is otherwise broadband enough to pass. That works for most
ducks and means it is never dead on arrival.

The mic is opened with `echoCancellation`, `noiseSuppression` and `autoGainControl` all
off — every one of them is designed to chew up exactly the kind of short broadband
transient this is trying to detect.

The duck's status line nags on the same principle — `squeeze it`, then `don't stop
now`, then `still holding it, still not squeezing` once nothing has been heard for
twenty seconds.

The scope draws the live spectrum with the template over it, which is the thing to look
at when it won't trigger on the day: it shows whether the duck is missing the template
or just too quiet. `Duck.tune({tau, perSqueeze, sim, energy, flux})` adjusts the
thresholds live, and `Duck.squeeze()` charges it without a duck.

Untick **Locked** to play without any of this.

## Pumping Claude

`./bellows` runs Claude Code and freezes it whenever you stop pumping the lid.

A harmonium player's left hand never stops. The moment the bellows stop moving the reeds
starve and the note dies, however many keys are held down. This does that to a language
model. Normally you need the lid open for the machine to be awake; here open is not
enough, because the reservoir fills with lid *travel* and not lid position. Holding it
wide open is not pumping. Only moving it counts.

The gate is a real process signal, not filtered input. At the low-water mark the child
gets `SIGSTOP` and is suspended by the kernel — mid-token, mid-tool-call, not thinking
and not spending anything — and `SIGCONT` picks it up exactly where it was. The terminal
sits frozen on a half-written sentence until air arrives.

    ./bellows                     # sandboxed Claude, gated on the hinge, reeds playing
    ./bellows --dry               # just the meter, for tuning the feel
    ./bellows --no-sound          # no dashboard, no reeds
    ./bellows -- --model sonnet   # anything after -- goes to Claude

### You can hear the air

`bellows` brings up the dashboard and puts it on screen playing, so the same pump does
two jobs. The reeds and the supervisor read the sensor independently — nothing is piped
between them — which means the note you are hearing *is* the air Claude is running on.
Stop moving and the drone sags, then dies, then Claude freezes.

The two reservoirs are deliberately mismatched. The harmonium drains in about two
seconds against the supervisor's fifteen, so the sound going is the early warning and
the freeze is the consequence: you get a full ten seconds of a note falling apart before
anything actually stops, which is enough time to do something about it.

The page is opened with `?bellows=1`, which takes the duck's gate off — the lid is
already the only input here and a second lock would just be in the way.

Browsers require a gesture before they will make noise, so the window is launched with
`--autoplay-policy=no-user-gesture-required` against a **throwaway browser profile** in
`sandbox/browser`. That keeps the relaxed policy on this one window and out of the
browser you actually read mail in. Chrome, Brave, Edge and Chromium all take the same
flags; failing all four it falls back to `open`, and the page asks for one click.

If a dashboard is already serving on the port, `bellows` uses it rather than starting a
second one, and leaves it running on exit.

### The nagging

The status line is keyed on *why* it is unhappy, not just how empty it is. A lid being
pumped badly and a lid held wide open are different failures and get different abuse:
holding still while the air drains gets `keep blowing`, and holding still long enough
that it has clearly given up gets `open is not the same as trying`. Lines rotate every
2.6 seconds so a tier reads as nagging rather than a stuck string.

Every line is literally about pumping a bellows. That they read as something else is the
point, and the reason none of them say anything you could not put on the side of a
Victorian harmonium.

### Why it is two thresholds and not one

A single threshold flaps. Pressure hovers on the boundary, and the child is stopped and
continued dozens of times a second, which wedges the terminal rather than pausing it.
Claude resumes at 25% and is not frozen again until pressure falls all the way to 8%.

The instrument's TAU is 1.15 s, which starves a note in about two seconds — correct for
playing, unusable for typing. `bellows` defaults to 6 s, so one good pump buys about
fifteen seconds. `--tau` tightens it for a demo or loosens it to get anything done.

Two failure modes are deliberately open rather than closed. If the sensor dies — it
vanishes across sleep/wake — Claude runs free instead of being locked out with no way to
feed it. And the supervisor never exits without sending `SIGCONT` first, since a
suspended process left behind would be unkillable by ordinary means.

### Job control, the hard way

The child runs in its **own process group**, in the same session so it keeps the
controlling terminal, and is handed the terminal foreground the way a shell hands it to
a job (`tcsetpgrp`). This is not a detail. Sharing a process group means every
job-control signal aimed at the child hits the supervisor too — one ctrl-Z stops Claude
*and* the process responsible for resuming it, stranding a frozen tree with nothing
watching it. That is exactly how the first version failed, and it took a suspended
keychain operation with it.

Being in a background group means writing to the terminal would raise `SIGTTOU`, so that
and `SIGTTIN` are ignored. Ctrl-C now reaches only the foreground group, which is
Claude's; the supervisor ignores it as well, since it must outlive the child.

Freezing signals the child's whole **group**, so a command Claude already started stops
with it rather than running on underneath a suspended parent.

    ./bellows --thaw     # resume anything a previous run left frozen

`--thaw` is the recovery hatch for a supervisor that was SIGKILLed and never got to run
its cleanup. It skips any Claude carrying editor session plumbing on its command line,
so it will not touch the Claude you actually work in.

### The reeds belong to the sandbox

The supervisor writes a heartbeat to `sandbox/session.json`, and the page polls
`/session`. With no live supervisor the reeds go quiet and say so.

Without this the dashboard plays for *any* lid movement — including while you are
working in your real Claude, which has nothing to do with the sandbox and did not ask
for a soundtrack. A heartbeat older than three seconds counts as gone, and the write is
atomic (`os.replace`) so the page never reads a half-written file.

### The sandbox

Everything runs against `sandbox/` — its own `CLAUDE_CONFIG_DIR` and its own workspace,
both gitignored. The Claude you actually use is untouched: separate credentials,
separate history, separate settings.

Because the config is fresh, **the first run will ask you to authenticate**, and that
login is only for the sandbox.

`claude` on PATH may be a launcher that injects hooks and a session id into the
surrounding editor — exactly the coupling this is meant to avoid — so `bellows` skips
shell wrappers in favour of the real binary they delegate to, and strips the editor's
session variables from the child's environment. `BELLOWS_CLAUDE` overrides the choice.

### Where the nagging shows up

Claude owns the screen while it is running, so the live status goes in the terminal
*title* — an OSC escape no full-screen program repaints over.

The moment it freezes, though, the screen is fair game: SIGSTOP means Claude cannot
repaint. So a banner is painted across the bottom of the terminal for exactly as long as
the child is stopped, and wiped the instant air returns. It escalates — amber when you
have just stopped, coral once the lid has been held still, red and shouting when you
have plainly given up:

    ╭──────────────────────────────────────────────────────────────╮
    │ ●  CLAUDE IS FROZEN     0%  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
    │ COLD. LIMP. FINISHED.                                        │
    ╰──────────────────────────────────────────────────────────────╯

The terminal bell rings on the freeze itself (`--quiet` to stop that), and `--speak`
routes the nagging through `say`, so the laptop complains out loud. `--meter /dev/ttys004`
draws a proper bar in a second terminal.

One honest limitation: only Claude's own process is suspended. Commands it has already
spawned keep running to completion.

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
- `duck.js` — rubber duck squeak detection and the charge that gates the output
- `bellows` — runs Claude Code, suspended whenever the lid stops pumping
- `dashboard` — launcher
