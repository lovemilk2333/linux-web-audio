// SPDX-License-Identifier: BSD-3-Clause

import type { Frame } from './protocol'

/**
 * Turns the payload of a frame into planar float samples.
 *
 * Opus has two decode paths, because WebCodecs is not everywhere. It is the
 * better one where it exists — native, no download — but a browser without it
 * would otherwise have to fall back to the server's raw PCM, which costs about
 * sixteen times the bandwidth. A WASM build of libopus fills that gap at 96
 * kbps instead of 1.5 Mbps, and is fetched only when it is needed.
 *
 * So, in order of preference:
 *
 *   opus      → WebCodecs AudioDecoder      native, no download
 *   opus      → opus-decoder (WASM libopus) ~85 KiB, fetched on demand
 *   pcm_*     → nothing to decode           last resort, ~1.5 Mbps
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

/** How Opus would be decoded here. */
export type OpusPath = 'webcodecs' | 'wasm' | 'none'

/**
 * What it would take to decode Opus in this browser.
 *
 * The WASM decoder is not loaded to answer this: it is a download, so the
 * question is only whether it could be.
 */
export async function opusPath(format: StreamFormat): Promise<OpusPath> {
  if (await webCodecsOpusSupported(format)) return 'webcodecs'
  return 'wasm'
}

/** Whether this browser can decode Opus through WebCodecs. */
export async function webCodecsOpusSupported(format: StreamFormat): Promise<boolean> {
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
 * Opus is preferred for bandwidth, and there are two ways to decode it. Raw
 * PCM is the last resort: it needs nothing from the browser, and costs about
 * sixteen times as much.
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

  if (has('opus')) {
    const path = await opusPath(format)
    return {
      codec: 'opus',
      reason:
        path === 'webcodecs'
          ? 'WebCodecs decodes Opus natively here'
          : 'no WebCodecs here, so Opus is decoded by a WASM build of libopus',
    }
  }

  for (const fallback of ['pcm_s16le', 'pcm_f32le']) {
    if (has(fallback)) {
      return {
        codec: fallback,
        reason: 'the server offers no Opus stream, using raw PCM',
      }
    }
  }

  throw new Error(`no playable codec: the server offers ${offered.join(', ') || 'nothing'}`)
}

/**
 * Builds a decoder.
 *
 * Asynchronous because the WASM fallback has to load, and the caller should
 * know that before audio starts rather than discovering it mid-stream.
 */
export async function createDecoder(
  codec: string,
  format: StreamFormat,
  sink: SampleSink,
  onError: (error: Error) => void,
): Promise<Decoder> {
  switch (codec) {
    case 'opus':
      if (await webCodecsOpusSupported(format)) {
        return new WebCodecsOpusDecoder(format, sink, onError)
      }
      return WasmOpusDecoder.create(format, sink, onError)
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
class WebCodecsOpusDecoder implements Decoder {
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
 * Opus through a WASM build of libopus.
 *
 * For browsers without WebCodecs. It costs an ~85 KiB download, so the import
 * is dynamic: Vite puts it in its own chunk and a browser that can use
 * WebCodecs never fetches it.
 *
 * Unlike the WebCodecs path this decodes synchronously, which is fine — a
 * 20 ms packet takes microseconds — and means packets cannot pile up behind an
 * asynchronous queue.
 */
class WasmOpusDecoder implements Decoder {
  readonly codec = 'opus'
  private closed = false

  private constructor(
    private decoder: OpusDecoderInstance,
    private format: StreamFormat,
    private sink: SampleSink,
  ) {}

  /** Loads the WASM module and prepares a decoder. */
  static async create(
    format: StreamFormat,
    sink: SampleSink,
    onError: (error: Error) => void,
  ): Promise<WasmOpusDecoder> {
    try {
      // Dynamic on purpose: this is the whole point of the tier.
      const { OpusDecoder } = await import('opus-decoder')
      const decoder = new OpusDecoder({
        sampleRate: wasmSampleRate(format.sampleRate),
        channels: format.channels,
      })
      await decoder.ready
      return new WasmOpusDecoder(decoder, format, sink)
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      onError(new Error(`could not load the Opus decoder: ${error.message}`))
      throw error
    }
  }

  get backlog(): number {
    // Decoding is synchronous, so nothing is ever waiting.
    return 0
  }

  decode(frame: Frame): void {
    if (this.closed) return

    const { channelData, samplesDecoded } = this.decoder.decodeFrame(frame.payload)
    if (samplesDecoded === 0) return

    /* Copied, necessarily. channelData are views into the WASM heap and are
     * overwritten by the next call; the player moves the buffers it is given
     * to the audio thread, and transferring a view of the WASM heap would
     * detach it. */
    const channels = channelData.map((plane) => plane.slice(0, samplesDecoded))
    while (channels.length < this.format.channels) {
      channels.push(new Float32Array(samplesDecoded))
    }

    this.sink(channels, samplesDecoded)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.decoder.free()
  }
}

/**
 * Narrows a sample rate to the ones Opus defines.
 *
 * Opus supports exactly five rates, and libopus refuses to build an encoder for
 * anything else — so a server that got this far cannot be producing one of
 * them. The check is here to keep the type honest rather than to handle a case
 * that can happen.
 */
function wasmSampleRate(rate: number): 8000 | 12000 | 16000 | 24000 | 48000 {
  switch (rate) {
    case 8000:
    case 12000:
    case 16000:
    case 24000:
    case 48000:
      return rate
    default:
      throw new Error(`Opus has no ${rate} Hz mode; the stream rate is not one Opus can decode`)
  }
}

/** The slice of opus-decoder's API this file uses. */
interface OpusDecoderInstance {
  ready: Promise<void>
  decodeFrame(packet: Uint8Array): { channelData: Float32Array[]; samplesDecoded: number }
  free(): void
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
