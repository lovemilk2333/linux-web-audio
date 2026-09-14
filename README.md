# linux-web-audio

Desktop audio, captured on Linux and streamed over HTTP as Opus.

A Go server captures what the machine is playing, encodes it, and broadcasts it
over a long-lived HTTP response to any number of clients. The capture itself
lives in a separate GPL-3 licensed shared library, pulled in as a submodule.

```
default sink's monitor
  └─(pa_simple_read)  libwebaudio.so ── capture/  (C++, GPL-3.0)
       └─(cgo)  one 20 ms frame at a time
            └─ hub: assign seq + sample timestamp, encode once per codec,
                    record history, fan out to every client
                 └─ HTTP chunked: 16-byte header + one encoded packet
```

## Quick start

```sh
git clone --recurse-submodules https://github.com/lovemilk2333/linux-web-audio
cd linux-web-audio
make build
./bin/webaudiod

# in another terminal
curl -s localhost:8642/audio/info
./bin/webclient -duration 5s
```

Requirements: a C++17 compiler, CMake, Go 1.24+, `libpulse-simple` and `libopus`
with their development headers, and a running PipeWire or PulseAudio session.

On Arch: `pacman -S base-devel cmake go libpulse opus`.

## Listening to it

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
--listen 127.0.0.1:8642     --codec opus              --bitrate 96000
--complexity 5              --frame-duration 20       --sample-rate 48000
--channels 2                --sink ""                 --history-packets 750
--client-queue 64           --slow-client fast-forward
--token ""                  --vbr --dtx --fec         --log-level info
```

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

**The macOS/Windows part of Sunshine is not here.** This is Linux only.

## Relationship to Sunshine

The capture library is a port of [Sunshine's](https://github.com/LizardByte/Sunshine)
Linux audio backend, and both repositories are GPL-3.0 because of it. Sunshine
has no HTTP interface and no equivalent of the resume protocol; that part is
this project's.

Sunshine captures audio through **libpulse**, not native PipeWire — its PipeWire
code is video-only. So does this, which on a PipeWire system means going through
`pipewire-pulse`. See `capture/NOTICE` for the exact derivation and
`capture/README.md` for the list of deliberate departures from Sunshine.

## Repository layout

```
cmd/webaudiod       the server
cmd/webclient       reference client, and the tool used to verify the protocol
internal/proto      the wire format, and the wrap-safe sequence arithmetic
internal/codec      Opus and raw PCM encoders, selected by name
internal/hub        broadcast core: sequencing, history, fan-out, slow clients
internal/server     the HTTP surface
internal/source     drives the capture library and publishes frames
internal/capweba    the only package that touches C
capture/            submodule: the GPL-3 capture library
docs/protocol.md    the wire format, for anyone writing a client
```

## Building and testing

The Go binaries link the capture library, so **the library must be built first**.
`make` handles the ordering; a bare `go build` will not work until `make lib`
has run once.

```sh
make lib      # build capture/build/libwebaudio.so from the submodule
make build    # build both binaries into bin/
make test     # the library's self test, then the Go tests
make run      # build and start the server
```

`make test` runs the library's self test against the live audio session, so it
needs a working audio server. The Go packages `proto`, `codec` and `hub` are
tested without the capture library at all — `go test ./internal/proto/... ./internal/codec/... ./internal/hub/...`
works with nothing built.

The library's own tests:

```sh
capture/build/webaudio_selftest              # asserts format, cadence, lifecycle
capture/build/webacap-dump out.wav 5         # capture to a WAV, with live stats
```

## Licence

GPL-3.0. The capture library is a derivative work of Sunshine and is
GPL-3.0-or-later; because it is linked into the server, the whole thing is
GPL-3.0. See [LICENSE](LICENSE) and `capture/NOTICE`.
