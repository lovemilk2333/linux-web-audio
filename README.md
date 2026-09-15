# linux-web-audio

Desktop audio, captured on Linux and streamed over HTTP as Opus.

A Go server captures what the machine is playing, encodes it, and broadcasts it
to any number of clients. A browser opens a WebSocket; everything else can still
read a long-lived HTTP response of the same packets.

```
default sink's monitor
  └─(pa_simple_read)  libwebaudio.so ── installed separately, GPL-3.0
       └─(cgo)  one 5 ms frame at a time
            └─ hub: assign seq + sample timestamp, encode once per codec,
                    record history, fan out to every client
                 └─ WebSocket binary, or HTTP chunked: 16-byte header + one packet
```

`libwebaudio` is **not part of this repository**. It is a separate GPL-3.0
project the user installs, which is what lets this source stay BSD-3-Clause.
See [Licence](#licence) — the distinction matters if you redistribute binaries.

## Install the capture library

```sh
git clone https://github.com/lovemilk2333/linux-web-audio-capture
cd linux-web-audio-capture
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
cmake --install build --prefix ~/.local
```

Installing to `/usr/local` works too, but on Arch pkg-config does not search
`/usr/local/lib/pkgconfig`, so you would still need `PKG_CONFIG_PATH`.

## Build and run

```sh
# The capture library has to be findable before anything is built. Both are
# needed when it went to ~/.local rather than a path the system already
# searches; the first is read by the compiler, the second by the loader.
export PKG_CONFIG_PATH=~/.local/lib/pkgconfig
export LD_LIBRARY_PATH=~/.local/lib

git clone https://github.com/lovemilk2333/linux-web-audio
cd linux-web-audio
make build
./bin/webaudiod

# in another terminal
curl -s localhost:8642/backend/audio/info
./bin/webclient -duration 5s
```

Requirements: Go 1.24+, `libopus` with development headers, and the capture
library above. On Arch: `pacman -S go opus`. The browser frontend additionally
needs Node 20+ and pnpm.

`make check-lib` prints the install instructions above if pkg-config cannot find
the library.

## Listening in a browser

`frontend/` is a Vue 3 + Vite page that plays the stream through an AudioWorklet
and shows what the protocol is doing: packet rate, buffer level, gaps, and the
resume path.

Opus is decoded with WebCodecs where the browser has it, and otherwise by an
`opus-decoder` WASM chunk fetched on demand — so a phone keeps the 96 kbps
stream instead of falling back to the ~1.5 Mbps raw PCM, which is only used
when neither is available.

```sh
cd frontend
pnpm install
pnpm dev                                   # http://127.0.0.1:5173
```

The dev server forwards `/backend` to the API, so the page and the stream share
an origin and nothing needs configuring — no `--cors`, no server address:

```sh
./bin/webaudiod                      # serves /backend by default
cd frontend && pnpm dev              # proxies /backend to it
```

Point `WEBAUDIO_API` at another host if the server is not on the default port:

```sh
WEBAUDIO_API=http://127.0.0.1:9000 pnpm dev
```

See [`frontend/README.md`](frontend/README.md).

## Listening from the command line

`webclient` is a reference client. It verifies continuity, and can decode the
stream back to a WAV:

```sh
./bin/webclient -duration 10s -out capture.wav
```

It also exercises the part of the protocol that is easy to get wrong — dropping
the connection and resuming without a gap:

```sh
./bin/webclient -resume-test -resume-after 2s
```

```
--- resume test ---
disconnect after seq 1309, resume from seq 1310
waiting 1s so audio accumulates server-side

resume result:
  asked for seq 1310, first packet was seq 1310
  50 of 201 packets were flagged as replays
  no sequence gaps across the reconnect
```

See [`docs/protocol.md`](docs/protocol.md) for the wire format and the HTTP
semantics, written so a client can be implemented in any language.

## What it captures

By default, the monitor of the **current default output device** — everything
the desktop is playing. When the default output changes, the capture follows it
within a second and reports the move in `/audio/info`.

A specific device can be pinned instead:

```sh
./bin/webaudiod --sink alsa_output.pci-0000_00_1f.3.analog-stereo
```

This is deliberately **not** a virtual sound device: it does not create a null
sink or reroute anything, so apps keep playing to where the user expects. The
trade-off is that it captures all system audio rather than one application's.

Because capture goes through the session's audio socket, the server must run as
the logged-in user — that is what [`deploy/webaudiod.service`](deploy/webaudiod.service)
is for.

## Options

```
--listen 127.0.0.1:8642     --base-path /backend      --codec opus
--bitrate 96000             --frame-duration 5        --sample-rate 48000
--complexity 3              --channels 2              --sink ""
--history-packets 750       --client-queue 64         --slow-client fast-forward
--token ""                  --token-file ""           --cors ""
--allowed-hosts ""          --allow-anonymous
--tls-cert "" --tls-key ""  --vbr --dtx --fec         --log-level info
```

Endpoints live under `--base-path`, `/backend` by default, so the API can sit
beside a web page on one origin:

```
/backend/audio/info    /backend/audio/stream    /backend/healthz
```

Pass `--base-path ""` to mount at the root instead.

`--listen` defaults to loopback because this streams what the desktop is
playing. If you expose it, set `--token`: the server then requires
`Authorization: Bearer <token>` on every endpoint except `/healthz`.

The Opus defaults match Sunshine's: the restricted-low-delay mode and constant
bitrate, so the wire rate is predictable.

Multiple codecs can be offered at once. Each is encoded once per frame and only
while it has a subscriber, so an idle codec costs nothing:

```sh
./bin/webaudiod --codec opus,pcm_s16le
./bin/webclient -codec pcm_s16le -duration 3s    # the known-length codec
```

## Security

This serves everything the machine is playing — calls, meetings, notifications,
media. The defaults are chosen for that, and three of them are refusals rather
than warnings, because a warning on a one-flag mistake is not a control.

**Loopback is not the same as private.** Binding to `127.0.0.1` keeps other
machines out, but not the browser of whoever is sitting at this one. A page on
`attacker.example` can let its DNS expire and re-resolve to `127.0.0.1`; the
browser then sees one origin, applies no CORS, and can read the stream. The
giveaway is the `Host` header still naming `attacker.example`, so the server
refuses any `Host` it does not answer to — loopback names always, plus whatever
`--allowed-hosts` names for a bind that cannot enumerate itself.

The rest:

- **`--cors *` requires a token.** `*` tells every browser that any site may
  read the response, so without a token any page the user visits becomes a
  listener. Name the origin instead, which is what a dev server needs anyway.
- **Binding beyond loopback without a token refuses to start.** Use `--token`,
  `--token-file` or `WEBA_TOKEN`. `--allow-anonymous` exists for the case where
  that is genuinely intended, and says so in the log every time.
- **Prefer `--token-file` over `--token`.** A flag value is visible in
  `/proc/<pid>/cmdline` to every user on the machine; the file only puts its
  path there. `deploy/webaudiod.service` uses an environment file for the same
  reason.
- **A token is not confidentiality.** Over plain HTTP the bearer header and the
  audio are both readable by anyone on the path, so a token alone on an exposed
  interface is authentication without secrecy. Use `--tls-cert`/`--tls-key`, or
  terminate TLS in front of the server; it warns when it is serving plain HTTP
  beyond loopback.
- **A browser WebSocket cannot set `Authorization`.** The page therefore puts
  the token on `?token=` of `/audio/stream` only. That query will appear in
  reverse-proxy access logs. HTTP clients, including `/audio/info`, keep using
  the bearer header.

None of this protects against a malicious process already running as your user:
it can open `/run/user/$UID/pipewire-0` and capture the same audio directly.

### Serving a browser from another origin

Proxying is the easier arrangement — the page and the API on one origin, which
is what `pnpm dev` sets up. To let a page call the API directly across origins
instead, allow its origin:

```sh
./bin/webaudiod --cors 'http://localhost:5173'      # or a comma-separated list, or *
```

Origins are validated, because a stray trailing slash or a missing scheme
produces no visible error — the browser simply refuses the request and the page
reports a network failure.

CORS also makes the server expose its `X-Audio-*` response headers. Without that
a browser hides them, and a page cannot read the sequence range off a 416 to
recover from an expired resume point.

## Behaviour worth knowing

**The stream never stops.** When the desktop is silent, or the output device
goes idle, the server sends silence rather than nothing. A stream whose packets
stop arriving is indistinguishable from a broken one at the client, and any
client using packet arrival as its clock would stall. It also makes packet
counts a dependable clock: `webclient` reports 6.020 s of audio in 6.019 s of
wall clock.

**Timestamps are a media clock, not wall clock.** They count samples and advance
by exactly one frame per packet, through silence as well as audio, so a client
can convert a difference into a duration and detect a gap exactly.

**A slow client cannot stall the stream.** Each subscriber has a bounded queue
and an overflow policy (`--slow-client`). The default fast-forwards: it discards
the backlog and delivers the newest packet, flagging it `discontinuity` so the
client knows. Measured impact on a fast client while another is throttled to
1 KiB/s: none.

## Repository layout

```
cmd/webaudiod       the server
cmd/webclient       reference client, and the tool used to verify the protocol
frontend/           browser player, served separately from the API
internal/proto      the wire format, and the wrap-safe sequence arithmetic
internal/codec      Opus and raw PCM encoders, selected by name
internal/hub        broadcast core: sequencing, history, fan-out, slow clients
internal/server     the HTTP surface, including CORS
internal/source     drives the capture library and publishes frames
internal/capweba    the only package that touches C
docs/protocol.md    the wire format, for anyone writing a client
```

## Licence

**BSD-3-Clause**, for this repository.

The capture library it links against, `libwebaudio`, is a derivative work of
[Sunshine](https://github.com/LizardByte/Sunshine) and is **GPL-3.0-or-later**.
It lives in its own repository and is installed separately by the user; no GPL
code is present here.

That separation is what keeps this source permissive, but it has a limit worth
being precise about: **a binary built here and linked against libwebaudio is a
combined work, and the GPL covers that combined work.** Dynamic linking is not a
boundary under the GPL — that mechanism belongs to the LGPL, and the FSF's
reading is that the whole program is covered however the linking is done.

In practice:

- Building and running it for yourself: no obligation. The GPL explicitly
  permits private use.
- Redistributing a binary linked against libwebaudio: that binary is GPL-3.0,
  and must come with the corresponding source under GPL-3.0 terms.
- Redistributing this source on its own: BSD-3-Clause, as the LICENSE says.

Sunshine captures audio through **libpulse**, not native PipeWire — its PipeWire
code is video-only. So does the capture library, which on a PipeWire system
means going through `pipewire-pulse`. See the capture repository's `NOTICE` for
the exact derivation.
