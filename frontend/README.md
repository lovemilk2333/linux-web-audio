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
                    └─ pcm_s16le → nothing, it is already samples
            └─ planar float chunks ── postMessage (buffers transferred)
                 └─ AudioWorklet: buffers, plays on the audio clock, meters
```

**Codec choice is automatic.** Opus is preferred, but it needs WebCodecs; when
the browser cannot decode it the page asks the server for `pcm_s16le` instead.
The server encodes each codec only while somebody wants it, so this costs
nothing when unused. The fallback is roughly ten times the bandwidth and needs
no decoder, which also makes it the useful setting when something sounds wrong.

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

## A note on the toolchain

TypeScript is pinned to 5.9 rather than 6 or 7. `vue-tsc` declares support for
anything from 5.0 up, but it loads the compiler through a path that newer
TypeScript versions no longer export, so it fails at startup with a module
resolution error rather than anything resembling a version conflict.
