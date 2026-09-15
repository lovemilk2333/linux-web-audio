# The wire protocol

A client fetches `/audio/info`, opens `/audio/stream`, and reads a sequence of
framed packets off a chunked HTTP response. To reconnect without a gap it passes
`?from_seq=N`.

Everything is big-endian. Both `seq` and `timestamp` wrap around, so they must be
compared as distances on a circle rather than as integers.

## Packet header

Each packet is a fixed 16-byte header followed by one encoded payload:

```
offset  size  field
 0       4    magic       "WEBU"
 4       1    version     1
 5       1    flags
 6       2    seq         uint16
 8       4    timestamp   uint32, in samples at the stream's sample rate
12       4    payload_len uint32
16       N    payload
```

There is no length prefix around the whole packet and no delimiter: the header
is self-describing, so a reader does:

```go
io.ReadFull(body, header[:16])           // then parse payload_len
io.ReadFull(body, make([]byte, n))       // exactly one payload
```

## Flags

| Bit | Name | Meaning |
| --- | --- | --- |
| 0 | `discontinuity` | packets were dropped before this one; the stream is not continuous |
| 1 | `silence` | this payload is synthesized silence, not captured audio |
| 2 | `underrun` | the capture source delivered nothing when a frame was due |
| 3 | `catchup` | this packet is being replayed from history, not sent live |

`silence` and `underrun` always appear together. Silence is sent rather than
nothing at all so the stream keeps a constant packet rate: a client that waits
for packets to drive its clock will not stall while the desktop is quiet. For
Opus this is cheap — DTX-aware encoders compress a silent frame to a few bytes.

`discontinuity` is the flag that matters for correctness. It appears when the
server dropped packets for this client (it fell behind), or when the capture
reopened onto a different device. A client that needs continuous audio must
either resync or resample across it.

## Sequence numbers and timestamps

`seq` increments by exactly one per packet and wraps at 65536, so at the default
5 ms frame it wraps every ~5.5 minutes.

`timestamp` is **not** wall clock. It counts samples at the stream's sample rate
and advances by exactly `frame_samples` per packet — 240 at the default — and it
keeps advancing through silence. It is therefore an exact media clock: a client
can convert a timestamp difference straight into a duration, and can detect a
gap by comparing the timestamp step against `frame_samples` rather than trusting
`seq` alone.

Both wrap, so compare like this:

```go
forward := uint16(want - got)          // distance forward from got to want
if int16(forward) > 0 { /* want is ahead */ }
```

Comparing `a > b` directly is wrong across the wrap.

## GET /audio/info

Capability discovery. Consult this before opening the stream.

```json
{
  "version": "1.0.0",
  "capture_library": "1.0.0",
  "codec": "opus",
  "codecs": ["opus", "pcm_f32le", "pcm_s16le"],
  "sample_rate": 48000,
  "channels": 2,
  "frame_samples": 240,
  "frame_duration_ms": 5,
  "bitrate": 96000,
  "sink": "alsa_output.pci-0000_01_00.1.hdmi-stereo-extra1",
  "monitor": "alsa_output.pci-0000_01_00.1.hdmi-stereo-extra1.monitor",
  "current_seq": 1794,
  "oldest_seq": 1045,
  "history_packets": 750,
  "started": true,
  "subscribers": 0,
  "uptime_seconds": 36.5,
  "capture_reopens": 0,
  "header_size": 16,
  "timestamp_unit": "samples"
}
```

`sink` and `monitor` report where audio is being captured *now*: the capture
follows the default output device, so these change when the user switches
devices, and `capture_reopens` counts how often that has happened.

`oldest_seq`/`current_seq` describe the resume window. A `from_seq` outside
`[oldest_seq, current_seq]` is refused.

## GET /audio/stream

| Query parameter | Meaning |
| --- | --- |
| `codec` | one of `codecs`; defaults to the server's `--codec` |
| `from_seq` (or `seq`) | resume at this sequence number; omitted means join at the live edge |

### Responses

**200** — the stream. Headers:

```
Content-Type: application/octet-stream
Cache-Control: no-store
Transfer-Encoding: chunked
X-Audio-Codec: opus
X-Audio-SampleRate: 48000
X-Audio-Channels: 2
X-Audio-Frame-Samples: 240
X-Audio-Frame-Duration-Ms: 5
X-Audio-Header-Size: 16
X-Audio-Seq-Start: 1795
```

`X-Audio-Seq-Start` is the sequence number of the first packet that will follow.
For a live join it is the server's current edge; for a resume it is what you
asked for.

**400** — unknown codec, or a `from_seq` that is not an integer in 0..65535. An
unknown codec also sets `X-Audio-Codecs` to the supported list.

**416** — the requested `from_seq` is no longer held, or is ahead of what has
been produced. This is the range-check semantics of a byte-range request applied
to a sequence number. The response carries:

```
X-Audio-Seq-Oldest: 1045
X-Audio-Seq-Current: 1794
```

A client should read those and either retry at a valid point or reconnect
without `from_seq` to start live.

**401** — the server was started with `--token` and the request lacked a matching
`Authorization: Bearer <token>`. The response carries `WWW-Authenticate`.

### The stream never ends on its own

The response stays open until the client disconnects or the server stops. There
is no end marker and no content length. Practically:

- Do not set a whole-request timeout. A client that times out needs to reconnect
  with `from_seq`, which is exactly what the resume path is for.
- Read with a bounded per-packet timeout so a stalled connection is noticed.

## Resuming without a gap

This is the flow the protocol is built around.

1. Connect without `from_seq`. Audio starts at the live edge; note the `seq` of
   each packet you receive.
2. The connection drops. You have audio up to seq `N`.
3. Reconnect with `?from_seq=N+1`.
4. The server replays the packets it still holds, from `N+1` up to its current
   edge, each flagged `catchup`, then continues live with no gap.
5. If the response is 416 instead, the server no longer holds `N+1` — it has
   been overwritten by newer audio. Read `X-Audio-Seq-Oldest` and decide: resume
   from there and accept a gap, or start live and accept a gap of a different
   size. Either way you know a gap happened, which is the point.

The server holds `history_packets` packets — 750 by default, about 3.8 seconds at
the default 5 ms frame duration.

A worked example, from the reference client:

```
disconnect after seq 1309, resume from seq 1310
waiting 1s so audio accumulates server-side

resume result:
  asked for seq 1310, first packet was seq 1310
  50 of 201 packets were flagged as replays
  no sequence gaps across the reconnect
```

## Codecs

| Name | Payload | Notes |
| --- | --- | --- |
| `opus` | one Opus packet | Default. 48 kHz, constant bitrate, restricted-low-delay mode. Round-trips at ~42 dB SNR with 4.77 ms of codec latency. |
| `pcm_f32le` | raw float32 | 32-bit float, interleaved. No compression, no decoder needed. |
| `pcm_s16le` | raw int16 | 16-bit signed, interleaved, clamped rather than wrapped. |

The PCM codecs have a payload length that is exactly
`frame_samples * channels * bytes_per_sample` — 960 bytes for `pcm_s16le` and
1920 for `pcm_f32le` at the default 5 ms frame. Any other length is a framing
bug, which makes them the useful codecs for debugging a client. At 48 kHz stereo
they cost about 1.5 and 3 Mbps respectively.

Note that Opus needs no container here: each payload is one self-contained
packet and the header supplies the timing, so a client hands the payload
straight to a decoder. There is no Ogg or WebM framing.

## Silence, and why packets never stop

The capture library guarantees a packet every frame period. When the desktop is
silent — or the output device is idle — the frame is zeros flagged `silence`.
This is deliberate: a stream whose packets stop arriving is indistinguishable
from a broken one at the client, and any client using packet arrival as its
clock would stall.

It also means packet counts are a dependable clock. The reference client checks
this, and reports `ratio 1.0002` — 6.020 seconds of audio in 6.019 seconds of
wall clock.
