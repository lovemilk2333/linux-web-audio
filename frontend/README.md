# linux-web-audio frontend

A browser player and monitor for the stream. It connects to an HTTP long
connection, decodes what arrives, and plays it through an AudioWorklet.

No server code lives here: this is a static page. It reaches the API over the
network, which means **the server needs `--cors`** for wherever this page is
served from.

## Running it

```sh
pnpm install

# against the dev server
pnpm dev            # http://127.0.0.1:5173

# or build and serve the static output
pnpm build
pnpm preview        # http://127.0.0.1:4173
```

Start the API with the page's origin allowed:

```sh
webaudiod --cors 'http://127.0.0.1:5173'      # or :4173 for preview, or *
```

Origins must have a scheme and no trailing slash. A mistake there produces no
error at all — the browser simply refuses the request and the page reports a
network failure.

The server address is a field on the page and defaults to
`<current host>:8642`, so serving the page from the same machine needs no
configuration.

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
