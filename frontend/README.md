# linux-web-audio frontend

A browser player and monitor for the stream. It opens a WebSocket, decodes
what arrives, and plays it through an AudioWorklet. The HTTP long-connection
path is what `webclient` speaks; the page does not fall back to it.

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
GET /audio/stream  (WebSocket binary messages)
  └─ one 16-byte header + payload per frame ── FrameParser
       └─ decoder ──┐
                    ├─ opus      → opus-decoder (WASM libopus)
                    ├─ opus      → WebCodecs AudioDecoder (if WASM cannot load)
                    └─ pcm_*     → nothing, it is already samples
            └─ planar float chunks ── postMessage (buffers transferred)
                 └─ AudioWorklet: buffers, plays on the audio clock, meters
```

**Codec choice is automatic**, and Opus has two ways to be decoded:

| Path | When | Cost |
| --- | --- | --- |
| `opus-decoder` (WASM libopus) | default | ~87 kB, fetched on demand, synchronous |
| WebCodecs `AudioDecoder` | WASM failed to load | native, but internally queued (~100 ms) |
| raw PCM from the server | Opus is unavailable altogether | ~1.5 Mbps instead of 96 kbps |

WASM is the live path because WebCodecs queues: measured, samples come out
~130 ms after `decode()` on a 5 ms stream, which is most of a live budget.
libopus in WASM decodes a 5 ms frame in well under a millisecond. The WASM
chunk is imported dynamically, so a PCM-only session never fetches it.

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

**Playback is 1×, and the level is paid off in whole samples.** The audio
device and the capture source are separate clocks, both nominally 48 kHz and
actually a few tens of ppm apart, and a live source arrives at exactly playback
speed — so a drained buffer cannot refill by waiting, and stopping to rebuild
turns a 3 ms hole into a whole target of silence.

Tracking the target by *resampling* — reading slightly slow when short, slightly
fast when long — is the textbook answer and it is wrong here: a rate change is a
pitch change, and on a 20 ms buffer the level swings several milliseconds with
every packet, so the reader ends up warbling continuously. The distance to the
target is integrated into a debt instead, and the debt is paid one whole sample
at a time: a repeated sample when the buffer is short, a skipped one when it is
long. Spread through the block at up to four samples per 128, that is ~3% of
playback held back at the very most, and it leaves the pitch exactly where it
was.

Below four render blocks under the target — about 9 ms at the 20 ms default,
and never reached by ordinary packet jitter — the debt is accumulated four
times faster, so a buffer that genuinely drained refills in a fraction of a
second rather than crawling back. The debt is capped, so a long stall cannot
leave corrections owed for minutes.

The `correction` value in `window.__webaudio.player` is that debt, in samples.
`enqueuedFrames` against `playedFrames` is still how a clock mismatch is told
apart from a stream that is simply arriving slowly.

**The buffer is a real jitter buffer.** Playback waits until the target has
accumulated, then plays continuously. Starting on the very first packet
instead — the obvious implementation — leaves no margin, so every late packet
is heard as a click. Preroll and reconnect wait in silence even when
loop-on-underrun is on: the ring is the last session's audio, and repeating
it before anything new has arrived is a stutter, not a fill.

**Resuming is honoured.** On a reconnect the page asks for the packet after the
last one it saw, so the server replays what was missed rather than skipping a
hole. The WebSocket constructor cannot read a 416, so a resume the server no
longer holds is reported as a handshake close and the page joins at the live
edge instead of looping the same `from_seq`.

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
| refills | playback stopped to rebuild a buffer that had drained |
| looped | underrun blocks filled by repeating recent audio |
| stability | live-packet interarrival jitter; *steady* under 3 ms |
| gain | the playback gain in force, when it is not unity |
| clipping | samples clamped at full scale in the last report |

The **latency** list is encode time (from `/audio/info`), decode time, network
RTT (round trip of GET `/audio/info`; one-way is about half of that), the play
buffer, and live-packet interval / jitter. Encode + decode + RTT/2 + buffer is
what this page can measure.

**Loop on underrun** is off by default. When it is on, a drained buffer is filled
from about 40 ms of what just played instead of silence — a stutter rather than
a click. The page sends the buffer target as `?buffer_ms` so the server can
prefill that much history at 2× and pace a backlog against it.

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

The playback worklet is tested the same way, by driving it with a synthetic 1×
source whose sample values count upwards: what the reader did to the stream is
then readable straight off the output, since a value that appears twice is a
repeat, a missing one is a skip, and a value that was never sent means it
resampled. That is what holds the 1×-only rule in place.

## Browser support

Opus is what makes this cheap to run. It is decoded by the WASM build of
libopus, with WebCodecs as the fallback when that module cannot load — not the
other way round, because `AudioDecoder` queues:

- **Anything with WASM** — the `opus-decoder` chunk, ~87 kB, fetched on demand.
  Decoding is synchronous, so a 5 ms frame is well under a millisecond.
- **WebCodecs, when the WASM module cannot load** — native and nothing to
  download, but samples come out around 130 ms after `decode()` on a 5 ms
  stream, which is most of a live budget.
- **Neither** — raw PCM from the server. Works, but mind the bandwidth.

`AudioDecoder.isConfigSupported()` is what decides the fallback, at runtime
rather than from a user-agent string, so a browser that gains support starts
using it with no change here. That probe is also the reason a multi-channel
stream is handled correctly: Chromium reports `supported: true` for more than
two Opus channels without a `description`, then fails at `configure` — this
project is stereo only, so it does not hit that, but a future surround mode
would need the description supplied.

## A note on the toolchain

TypeScript is pinned to 5.9 rather than 6 or 7. `vue-tsc` declares support for
anything from 5.0 up, but it loads the compiler through a path that newer
TypeScript versions no longer export, so it fails at startup with a module
resolution error rather than anything resembling a version conflict.
