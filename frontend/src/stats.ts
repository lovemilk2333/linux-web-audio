// SPDX-License-Identifier: BSD-3-Clause

import { Flag, seqDistance, type Frame } from './audio/protocol'

/**
 * Counts what actually arrived.
 *
 * The interesting numbers are the ones a client can only get by checking: a
 * sequence gap means audio was lost, and a timestamp step that is not exactly
 * one frame means the media clock moved rather than the packets merely being
 * late. Both are computed with wrap-safe arithmetic, because the sequence
 * number is 16 bits and the timestamp 32.
 */
export class StreamStats {
  packets = 0
  bytes = 0
  gaps = 0
  missing = 0
  duplicates = 0
  outOfOrder = 0
  /** Packets served from the server's history rather than live. */
  catchup = 0
  /** Packets flagged as synthesized silence. */
  silence = 0
  /** Packets flagged as following a drop. */
  discontinuity = 0
  /** Timestamp steps that were not exactly one frame. */
  clockJumps = 0

  firstSeq: number | null = null
  lastSeq: number | null = null
  firstTimestamp: number | null = null
  lastTimestamp: number | null = null

  /** Set by the caller once the server's format is known; turns packet counts into durations. */
  sampleRate = 48000

  private startedAt = 0
  private stoppedAt = 0

  constructor(private frameSamples: number) {}

  reset(): void {
    Object.assign(this, new StreamStats(this.frameSamples))
  }

  start(): void {
    this.startedAt = performance.now()
    this.stoppedAt = 0
  }

  stop(): void {
    this.stoppedAt = performance.now()
  }

  observe(frame: Frame): void {
    if (this.packets === 0) {
      this.startedAt ||= performance.now()
      this.firstSeq = frame.seq
      this.firstTimestamp = frame.timestamp
    } else if (this.lastSeq !== null && this.lastTimestamp !== null) {
      const step = seqDistance(this.lastSeq, frame.seq)
      if (step === 1) {
        // Contiguous, as it should be.
      } else if (step === 0) {
        this.duplicates++
      } else if (step < 0x8000) {
        this.gaps++
        this.missing += step - 1
      } else {
        this.outOfOrder++
      }

      const advance = (frame.timestamp - this.lastTimestamp) >>> 0
      if (advance !== this.frameSamples) {
        this.clockJumps++
      }
    }

    this.lastSeq = frame.seq
    this.lastTimestamp = frame.timestamp
    this.packets++
    this.bytes += frame.payload.byteLength

    if (frame.flags & Flag.Catchup) this.catchup++
    if (frame.flags & Flag.Silence) this.silence++
    if (frame.flags & Flag.Discontinuity) this.discontinuity++
  }

  /** Wall clock covered so far, in seconds. */
  elapsedSeconds(): number {
    if (!this.startedAt) return 0
    const end = this.stoppedAt || performance.now()
    return (end - this.startedAt) / 1000
  }

  summary() {
    const elapsed = this.elapsedSeconds()
    const audio = (this.packets * this.frameSamples) / Math.max(this.sampleRate, 1)
    return {
      elapsed,
      audio,
      packetsPerSecond: elapsed > 0 ? this.packets / elapsed : 0,
      bytesPerSecond: elapsed > 0 ? this.bytes / elapsed : 0,
      /** Audio delivered per second of wall clock; 1.0 means nothing drifted. */
      ratio: elapsed > 0 ? audio / elapsed : 0,
    }
  }
}
