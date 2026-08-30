/* backing.js — a YouTube track playing under the harmonium.
 *
 * The track runs in YouTube's own iframe, which is cross-origin, so its audio cannot
 * be pulled into the Web Audio graph: no effects, no analysis, and the harmonium's
 * reeds simply mix with it at the output. What we can do through the IFrame API is
 * transport and volume — which is enough to duck the track under the reeds as the
 * bellows fill, so the harmonium sits on top instead of fighting the mix.
 */
(function () {
"use strict";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "lidangle.backing.url";

let player = null, apiReady = false, pending = null;
let baseVol = 55, duckOn = true, lastSetVol = -1, playing = false;

/* --- PARSE_START (kept self-contained so it can be unit-tested outside a browser) --- */
function parseVideo(input) {
  if (!input) return null;
  const raw = input.trim();
  // A bare 11-character id, as often pasted on its own.
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return { id: raw, start: 0 };
  let url;
  try {
    url = new URL(raw.match(/^https?:\/\//i) ? raw : "https://" + raw);
  } catch (e) {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  let id = null;
  if (host === "youtu.be") {
    id = url.pathname.slice(1).split("/")[0];
  } else if (host === "youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = url.pathname.match(/^\/(embed|shorts|v|live)\/([^/?#]+)/);
      if (m) id = m[2];
    }
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;

  // t / start accept "90", "1m30s", "1h2m3s"
  const t = url.searchParams.get("t") || url.searchParams.get("start") || "";
  let start = 0;
  if (/^\d+$/.test(t)) start = parseInt(t, 10);
  else {
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (m && (m[1] || m[2] || m[3])) start = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  }
  return { id, start };
}
/* --- PARSE_END --- */

function status(msg, bad) {
  const el = $("btStatus");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("bad", !!bad);
}

function load(input) {
  const v = parseVideo(input);
  if (!v) return status("That doesn't look like a YouTube link.", true);
  try { localStorage.setItem(STORE_KEY, input.trim()); } catch (e) { /* private window */ }
  if (!apiReady) { pending = v; return status("Loading YouTube player…"); }
  if (player) {
    player.loadVideoById({ videoId: v.id, startSeconds: v.start });
  } else {
    player = new YT.Player("ytplayer", {
      videoId: v.id,
      playerVars: { start: v.start, playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => { player.setVolume(baseVol); player.playVideo(); },
        onStateChange: (e) => {
          playing = e.data === YT.PlayerState.PLAYING;
          $("btPlay").textContent = playing ? "Pause" : "Play";
          $("btPlay").classList.toggle("on", playing);
          if (e.data === YT.PlayerState.PLAYING) status("Playing.");
          else if (e.data === YT.PlayerState.ENDED) status("Track ended.");
        },
        onError: (e) => {
          const why = {
            2: "YouTube rejected that video id.",
            5: "This video can't play in an embedded player.",
            100: "That video is private or no longer available.",
            101: "The owner has disabled embedding for this video.",
            150: "The owner has disabled embedding for this video.",
          }[e.data] || "YouTube returned error " + e.data + ".";
          status(why + " Try another track.", true);
        },
      },
    });
  }
  status("Loading…");
}

/* Called from the harmonium's tick with current bellows pressure. */
function duck(pressure) {
  if (!player || !player.setVolume) return;
  const target = Math.round(baseVol * (duckOn ? 1 - 0.5 * pressure : 1));
  if (target !== lastSetVol) {
    lastSetVol = target;
    player.setVolume(target);
  }
}

function init() {
  const urlBox = $("btUrl");
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) urlBox.value = saved;
  } catch (e) { /* private window */ }

  $("btLoad").addEventListener("click", () => load(urlBox.value));
  urlBox.addEventListener("keydown", (e) => { if (e.key === "Enter") load(urlBox.value); });
  $("btPlay").addEventListener("click", () => {
    if (!player) return load(urlBox.value);
    playing ? player.pauseVideo() : player.playVideo();
  });
  $("btVol").addEventListener("input", (e) => {
    baseVol = Number(e.target.value);
    lastSetVol = -1;
  });
  $("btDuck").addEventListener("change", (e) => { duckOn = e.target.checked; lastSetVol = -1; });

  // The IFrame API calls this global once it has loaded.
  window.onYouTubeIframeAPIReady = () => {
    apiReady = true;
    status("Ready — paste a link and hit Load.");
    if (pending) { const p = pending; pending = null; load(p.id); }
  };
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  tag.onerror = () => status("Couldn't reach YouTube — check your connection.", true);
  document.head.appendChild(tag);
  status("Loading YouTube player…");
}

window.Backing = { init, load, duck, parseVideo };
})();
