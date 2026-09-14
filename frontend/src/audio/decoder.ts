// SPDX-License-Identifier: BSD-3-Clause

import type { Frame } from './protocol'

/**
 * Turns the payload of a frame into planar float samples.
 *
 * Two families are supported. Opus goes through WebCodecs, which decodes raw
 * Opus packets directly — no container, no WASM, because the protocol already
 * delivers one self-contained packet per frame with the timing in the header.
 * The server's raw PCM codecs need no decoder at all, and exist so a browser
 * without WebCodecs still works: the page asks for one of those instead.
 */

export type SampleSink = (channels: Float32Array[], frames: number) => void

export interface Decoder {
  readonly codec: string
  /** Decode one frame. Never blocks. */
  decode(frame: Frame): void
  /** Packets handed over but not yet decoded. */
  readonly backlog: number
  close(): void
}

export interface StreamFormat {
  sampleRate: number
  channels: number
}

/** Whether this browser can decode Opus through WebCodecs. */
export async function opusSupported(format: StreamFormat): Promise<boolean> {
  if (typeof AudioDecoder === 'undefined') return false
  try {
    const support = await AudioDecoder.isConfigSupported({
      codec: 'opus',
      sampleRate: format.sampleRate,
      numberOfChannels: format.channels,
    })
    return support.supported === true
  } catch {
    return false
  }
}

/**
 * Picks a codec the server offers and this browser can actually play.
 *
 * Opus is preferred for bandwidth. If WebCodecs is missing the raw PCM codecs
 * are used instead — more than ten times the bandwidth, but they need nothing
 * from the browser beyond an AudioContext.
 */
export async function chooseCodec(
  offered: readonly string[],
  format: StreamFormat,
  preferred?: string,
): Promise<{ codec: string; reason: string }> {
  const has = (name: string) => offered.includes(name)

  if (preferred && has(preferred)) {
    return { codec: preferred, reason: 'requested' }
  }

  if (has('opus') && (await opusSupported(format))) {
    return { codec: 'opus', reason: 'WebCodecs can decode Opus' }
  }

  for (const fallback of ['pcm_s16le', 'pcm_f32le']) {
    if (has(fallback)) {
      return {
        codec: fallback,
        reason: has('opus')
          ? 'WebCodecs cannot decode Opus here, using raw PCM instead'
          : 'the server offers no Opus stream',
      }
    }
  }

  throw new Error(`no playable codec: the server offers ${offered.join(', ') || 'nothing'}`)
}

export function createDecoder(
  codec: string,
  format: StreamFormat,
  sink: SampleSink,
  onError: (error: Error) => void,
): Decoder {
  switch (codec) {
    case 'opus':
      return new OpusDecoder(format, sink, onError)
    case 'pcm_s16le':
      return new PcmDecoder(format, sink, 2)
    case 'pcm_f32le':
      return new PcmDecoder(format, sink, 4)
    default:
      throw new Error(`no decoder for codec ${codec}`)
  }
}

/**
 * Opus through WebCodecs.
 *
 * AudioDecoder is asynchronous, so decode() only hands the packet over; the
 * samples come back on the output callback. The queue is bounded, because a
 * decoder that falls behind would otherwise grow the page's latency without
 * limit — packets are dropped and the gap reported instead.
 */
class OpusDecoder implements Decoder {
  readonly codec = 'opus'
  private decoder: AudioDecoder
  private closed = false
  private dropped = 0

  constructor(
    private format: StreamFormat,
    private sink: SampleSink,
    onError: (error: Error) => void,
  ) {
    this.decoder = new AudioDecoder({
      output: (data) => this.emit(data),
      error: (error) => onError(error instanceof Error ? error : new Error(String(error))),
    })
    this.decoder.configure({
      codec: 'opus',
      sampleRate: format.sampleRate,
      numberOfChannels: format.channels,
    })
  }

  get backlog(): number {
    return this.decoder.decodeQueueSize
  }

  /** Packets dropped because the decoder could not keep up. */
  get droppedPackets(): number {
    return this.dropped
  }

  decode(frame: Frame): void {
    if (this.closed) return

    // Roughly a second of audio queued. Beyond that the page is falling
    // behind and dropping is better than accumulating delay.
    if (this.decoder.decodeQueueSize > 50) {
      this.dropped++
      return
    }

    this.decoder.decode(
      new EncodedAudioChunk({
        // Every Opus packet is independently decodable, so all of them are
        // key frames as far as WebCodecs is concerned.
        type: 'key',
        timestamp: Math.round((frame.timestamp / this.format.sampleRate) * 1_000_000),
        data: frame.payload,
      }),
    )
  }

  private emit(data: AudioData): void {
    try {
      const frames = data.numberOfFrames
      const channels: Float32Array[] = []
      for (let c = 0; c < this.format.channels; c++) {
        const plane = new Float32Array(frames)
        // Asking for f32-planar explicitly makes this independent of whatever
        // format the decoder chose to emit.
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
        channels.push(plane)
      }
      this.sink(channels, frames)
    } finally {
      // AudioData holds a decoder buffer that is only reclaimed here. Missing
      // this leaks one buffer per packet.
      data.close()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.decoder.state !== 'closed') this.decoder.close()
  }
}

/**
 * Raw PCM, already decoded by the server.
 *
 * The payloads are interleaved and little-endian. Their length is fixed and
 * known, which is what makes them useful for checking a client's framing: a
 * wrong length means the parser is out of step, not that the audio is noisy.
 */
class PcmDecoder implements Decoder {
  readonly codec: string

  constructor(
    private format: StreamFormat,
    private sink: SampleSink,
    private bytesPerSample: number,
  ) {
    this.codec = bytesPerSample === 2 ? 'pcm_s16le' : 'pcm_f32le'
  }

  get backlog(): number {
    return 0
  }

  decode(frame: Frame): void {
    const { channels, frames } = deinterleave(frame.payload, this.format.channels, this.bytesPerSample)
    this.sink(channels, frames)
  }

  close(): void {
    // Nothing to release: the conversion allocates and is done.
  }
}

/**
 * Splits interleaved little-endian samples into one array per channel.
 *
 * Exported for testing: getting this wrong produces noise rather than an
 * error, so it is worth checking directly.
 */
export function deinterleave(
  payload: Uint8Array,
  channelCount: number,
  bytesPerSample: number,
): { channels: Float32Array[]; frames: number } {
  const frames = Math.floor(payload.byteLength / (channelCount * bytesPerSample))
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames))

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channelCount; c++) {
      const at = (frame * channelCount + c) * bytesPerSample
      channels[c]![frame] =
        bytesPerSample === 2 ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true)
    }
  }

  return { channels, frames }
}
