// SPDX-License-Identifier: BSD-3-Clause

/**
 * The wire format, as specified in docs/protocol.md.
 *
 * Each packet is a 16-byte header followed by one encoded payload. The header
 * is self-describing, so a reader takes 16 bytes, learns how long the payload
 * is, then takes that many.
 */

/** "WEBU" in big-endian bytes, which is what the server writes. */
export const MAGIC = 0x57454255
export const VERSION = 1
export const HEADER_SIZE = 16

/**
 * Caps a claimed payload length, so a corrupt header cannot make the page
 * allocate without bound. Comfortably above the largest real payload: raw
 * float32 at 8 channels would be 30720 bytes.
 */
export const MAX_PAYLOAD = 1 << 20

/** Frame flags, mirroring the server's. */
export const Flag = {
  /** Packets were dropped before this one: the stream is not continuous. */
  Discontinuity: 1 << 0,
  /** This payload is synthesized silence rather than captured audio. */
  Silence: 1 << 1,
  /** The capture source delivered nothing when a frame was due. */
  Underrun: 1 << 2,
  /** This packet is replayed from history, not sent live. */
  Catchup: 1 << 3,
} as const

export interface Frame {
  flags: number
  /** Sequence number, 0..65535, wrapping. */
  seq: number
  /** Sample count since the start of the stream, wrapping at 2^32. */
  timestamp: number
  payload: Uint8Array
}

/** Renders a flag set for display. */
export function flagNames(flags: number): string[] {
  const names: string[] = []
  if (flags & Flag.Discontinuity) names.push('discontinuity')
  if (flags & Flag.Silence) names.push('silence')
  if (flags & Flag.Underrun) names.push('underrun')
  if (flags & Flag.Catchup) names.push('catchup')
  return names
}

export class ProtocolError extends Error {
  readonly offset: number

  constructor(message: string, offset: number) {
    super(message)
    this.name = 'ProtocolError'
    this.offset = offset
  }
}

/**
 * Reassembles frames from a byte stream.
 *
 * A chunk from the network has nothing to do with packet boundaries: it may
 * hold half a header, three packets, or a header and half a payload. Feed
 * whatever arrives to push() and take out whole frames.
 */
export class FrameParser {
  private buffer = new Uint8Array(0)
  /** A header already read, waiting for its payload. */
  private pending: Omit<Frame, 'payload'> | null = null
  private pendingLength = 0

  /** Bytes held while waiting for the rest of a frame. */
  get buffered(): number {
    return this.buffer.length
  }

  push(chunk: Uint8Array): Frame[] {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.buffer.length + chunk.length)
      merged.set(this.buffer, 0)
      merged.set(chunk, this.buffer.length)
      this.buffer = merged
    }

    const frames: Frame[] = []
    let offset = 0

    for (;;) {
      if (this.pending === null) {
        if (this.buffer.length - offset < HEADER_SIZE) break
        const header = this.readHeader(offset)
        this.pending = header
        this.pendingLength = header.length
        offset += HEADER_SIZE
      }

      if (this.buffer.length - offset < this.pendingLength) break

      frames.push({
        flags: this.pending.flags,
        seq: this.pending.seq,
        timestamp: this.pending.timestamp,
        payload: this.buffer.slice(offset, offset + this.pendingLength),
      })
      offset += this.pendingLength
      this.pending = null
      this.pendingLength = 0
    }

    // Keep only what is left over. Slicing rather than holding a subarray
    // view matters: a view would pin the whole chunk in memory, and the
    // network hands us a fresh chunk on every read.
    this.buffer = this.buffer.slice(offset)
    return frames
  }

  private readHeader(offset: number): Omit<Frame, 'payload'> & { length: number } {
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, HEADER_SIZE)

    const magic = view.getUint32(0)
    if (magic !== MAGIC) {
      throw new ProtocolError(
        `bad magic 0x${magic.toString(16).padStart(8, '0')}, expected 0x${MAGIC.toString(16)}`,
        offset,
      )
    }

    const version = view.getUint8(4)
    if (version !== VERSION) {
      throw new ProtocolError(`unsupported protocol version ${version}, expected ${VERSION}`, offset)
    }

    const length = view.getUint32(12)
    if (length > MAX_PAYLOAD) {
      throw new ProtocolError(`payload length ${length} exceeds the ${MAX_PAYLOAD} byte limit`, offset)
    }

    return {
      flags: view.getUint8(5),
      seq: view.getUint16(6),
      timestamp: view.getUint32(8),
      length,
    }
  }
}

/* -------------------------------------------------------------------------
 * Sequence arithmetic.
 *
 * The sequence number is 16 bits and wraps roughly every 22 minutes at the
 * default frame size, so it has to be compared as a distance on a circle.
 * Comparing the integers directly is wrong across the wrap.
 * ---------------------------------------------------------------------- */

/** Distance forward from `from` to `to`, wrapped into 0..65535. */
export function seqDistance(from: number, to: number): number {
  return (to - from) & 0xffff
}

/** Signed shortest distance from `from` to `to`, in -32768..32767. */
export function seqDiff(from: number, to: number): number {
  const d = seqDistance(from, to)
  return d >= 0x8000 ? d - 0x10000 : d
}

/** Whether `a` is strictly ahead of `b`. */
export function seqAhead(a: number, b: number): boolean {
  return seqDiff(b, a) > 0
}

/** Whether `seq` lies in the inclusive window [oldest, current]. */
export function seqInWindow(seq: number, oldest: number, current: number): boolean {
  return seqDiff(oldest, seq) >= 0 && seqDiff(seq, current) >= 0
}

/** The next sequence number after `seq`. */
export function seqNext(seq: number): number {
  return (seq + 1) & 0xffff
}
