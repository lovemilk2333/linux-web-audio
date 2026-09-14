# linux-web-audio frontend

A browser player and monitor for the stream. It connects to an HTTP long
connection, decodes what arrives, and plays it through an AudioWorklet.

No server code lives here: this is a static page. The dev and preview servers
forward `/backend` to the API, so the page and the stream share an origin and
there is nothing to configure — no CORS, and the Server field can stay blank.

Only a page served from somewhere that is *not* proxying needs `--cors`.

## Running it

```sh
pnpm install
pnpm dev            # http://127.0.0.1:5173, proxying /backend to the API

pnpm build          # or build the static output and serve it
pnpm preview        # http://127.0.0.1:4173, also proxying
```

Start the API separately, on its defaults:

```sh
webaudiod           # serves /backend on 127.0.0.1:8642
```

That is the whole setup: the dev server forwards `/backend` to
`127.0.0.1:8642`, so the page and the stream are same-origin. Point
`WEBAUDIO_API` elsewhere if your server is:

```sh
WEBAUDIO_API=http://192.168.1.5:8642 pnpm dev
```

Leave the page's **Server** field blank to use that proxy. Fill it in to reach
an API directly instead — a different host, or one with no proxy in front.
When the API is on another origin the browser needs `--cors` on the server, and
a mistake there produces no error at all: the browser simply refuses the
request and the page reports a network failure.

The API lives under a base path, `/backend` by default, matching the server's
`--base-path`. Set `VITE_API_BASE` at build time if you changed it.

## How it works

```
GET /audio/stream  (chunked, never ends)
  └─ ReadableStream ── FrameParser ── one 16-byte header + payload per frame
       └─ decoder ──┐
                    ├─ opus      → WebCodecs AudioDecoder
                    ├─ opus      → opus-decoder (WASM, fetched on demand)
                    └─ pcm_*     → nothing, it is already samples
            └─ planar float chunks ── postMessage (buffers transferred)
                 └─ AudioWorklet: buffers, plays on the audio clock, meters
```

**Codec choice is automatic**, and Opus has two ways to be decoded:

| Path | When | Cost |
| --- | --- | --- |
| WebCodecs `AudioDecoder` | the browser has it | native, nothing to download |
| `opus-decoder` (WASM libopus) | no WebCodecs, or it refuses the config | ~87 kB, fetched only then |
| raw PCM from the server | Opus is unavailable altogether | ~1.5 Mbps instead of 96 kbps |

The middle tier is what makes this usable on a phone. Without it, a browser that
cannot decode Opus falls straight to raw PCM, which is sixteen times the
bandwidth — a real problem on mobile data even though the audio itself is fine.
The WASM chunk is imported dynamically, so a browser that can use WebCodecs
never fetches it.

The last tier stays because it needs nothing from the browser beyond an
AudioContext, which makes it the useful setting when something sounds wrong: a
`pcm_s16le` payload is a fixed, known length, so a framing bug shows up as a
wrong length rather than as noise.

The server encodes each codec only while somebody wants it, so offering all of
them costs nothing when unused.

**Everything about timing lives in the worklet**, not the page. Timers on the
main thread are far too jittery to pace audio: they fire late under load, and
background tabs are throttled. The worklet is called by the audio clock and
drains a queue.

**Gain is applied on the audio thread**, not through a `GainNode`, so the level
meter reads what is actually heard. A node after the worklet would leave the
meter showing pre-gain levels, which is worse than useless when the whole point
of the control is that a stream is too quiet or too loud. The bottom of the
range is silence rather than −60 dB, positive gain clamps at full scale rather
than wrapping, and the meter grows a `clip` badge while that is happening — per
report window, so it clears again instead of latching on the first loud moment.

**The buffer corrects for clock drift.** The audio device and the capture
source are separate clocks, both nominally 48 kHz and actually a few tens of
parts per million apart. Measured on the development machine: 47999.4 frames
arrive per second while 48031.4 are played, so a buffer of any size drains
completely and rebuilds roughly every fifteen seconds, for as long as the tab
is open. Queueing cannot fix it, because the two sides disagree about how long
a second is. The reader is nudged instead — a short buffer repeats one frame at
a chunk boundary, a long one skips one — which spreads a correction of about
thirty frames a second over a hundred boundaries, where it is inaudible. The
alternative was a 20 ms dropout every fifteen seconds.

The corrector's gain is set so the steady level sits near the target rather
than a third of the way down it (which is where a weaker loop settled, and
why a 100 ms target still sawtoothed into underruns after the first fix).
Below half the target the shortfall is weighted harder, so reserve is rebuilt
at the one-frame-per-boundary cap before the buffer gets near empty. An early
refill at about one render quantum (~4 ms), with a short dwell and a one-second
cooldown, is only a safety net: it does not replace the corrector, and it is
kept far below ordinary burst jitter so it cannot thrash the way a level
threshold near the setpoint did.

The `correction` value in `window.__webaudio.player` shows what the corrector is
currently doing, and `enqueuedFrames` against `playedFrames` is how the drift
was found: two rates a few tens of frames apart, rather than a stream arriving
slowly.

**The buffer is a real jitter buffer.** Playback waits until the target has
accumulated, then plays continuously; the buffer is topped up as packets arrive
at playback speed. Starting on the very first packet instead — the obvious
implementation — leaves no margin, so every late packet is heard as a click.

**Resuming is honoured.** On a reconnect the page asks for the packet after the
last one it saw, so the server replays what was missed rather than skipping a
hole. If the server no longer holds that point it answers 416 with the range it
does have, and the page reports how much was lost rather than pretending.

## What the panels show

The **level meter** reads on a decibel scale from −60 dB, because a linear bar
looks dead at ordinary listening levels.

The **health list** is the part worth watching, since each row is something a
client can only know by checking:

| Row | What a problem means |
| --- | --- |
| sequence | a gap or a reorder — audio was lost |
| media clock | a timestamp step that was not exactly one frame |
| playback | the buffer ran dry, which is heard as a click |
| latency trim | audio discarded because the buffer grew too far |
| replayed | packets served from the server's history after a resume |
| gaps flagged | the server itself reported a discontinuity |
| gain | the playback gain in force, when it is not unity |
| clipping | samples clamped at full scale in the last report |

**The token is not saved.** It is held in memory for the session and retyped
after a reload. `localStorage` is readable by any script on the origin, so one
XSS or a malicious extension would otherwise hand over the secret protecting a
live feed of everything the machine plays. A version that persisted it will
have it stripped on next load.

`window.__webaudio` exposes the same state live, for the console:

```js
__webaudio.stats.summary()
__webaudio.player
__webaudio.events
```

## Testing

```sh
pnpm test        # unit tests: framing, sequence arithmetic, deinterleaving, stats
pnpm typecheck   # vue-tsc over the components and scripts
pnpm e2e         # browser tests against a live server — see e2e/README.md
```

The unit tests cover the logic that is easy to get subtly wrong and hard to
notice: a frame split across two network reads, a sequence number that wraps
from 65535 to 0, a timestamp step that is not one frame. None of those throw;
they produce noise or silence.

## Browser support

Opus is what makes this cheap to run. Where it cannot be decoded the page falls
back, but each step down costs bandwidth:

- **Chrome, Edge (desktop and Android), recent Firefox and Safari** — decode
  through WebCodecs. Chrome on Android has had `AudioDecoder` since 94, and
  third-party telemetry reports Opus decoding available in every Android
  Chromium session measured.
- **Anything else with WASM** — the `opus-decoder` chunk. Same bitrate, one
  small download.
- **No WASM either** — raw PCM. Works, but mind the bandwidth.

`AudioDecoder.isConfigSupported()` is what decides, at runtime rather than from
a user-agent string, so a browser that gains support starts using it with no
change here. That probe is also the reason a multi-channel stream is handled
correctly: Chromium reports `supported: true` for more than two Opus channels
without a `description`, then fails at `configure` — this project is stereo
only, so it does not hit that, but a future surround mode would need the
description supplied.

## A note on the toolchain

TypeScript is pinned to 5.9 rather than 6 or 7. `vue-tsc` declares support for
anything from 5.0 up, but it loads the compiler through a path that newer
TypeScript versions no longer export, so it fails at startup with a module
resolution error rather than anything resembling a version conflict.
