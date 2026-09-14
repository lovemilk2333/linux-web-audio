// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest'

import { deinterleave } from '../src/audio/decoder'
import { Flag, type Frame } from '../src/audio/protocol'
import { StreamStats } from '../src/stats'

const FRAME_SAMPLES = 960

function frame(seq: number, timestamp: number, flags = 0, bytes = 200): Frame {
  return { seq, timestamp, flags, payload: new Uint8Array(bytes) }
}

describe('StreamStats', () => {
  it('counts a contiguous stream as clean', () => {
    const stats = new StreamStats(FRAME_SAMPLES)
    for (let i = 0; i < 50; i++) {
      stats.observe(frame(i, i * FRAME_SAMPLES))
    }

    expect(stats.packets).toBe(50)
    expect(stats.gaps).toBe(0)
    expect(stats.missing).toBe(0)
    expect(stats.clockJumps).toBe(0)
    expect(stats.firstSeq).toBe(0)
    expect(stats.lastSeq).toBe(49)
  })

  it('counts a gap and how much it swallowed', () => {
    const stats = new StreamStats(FRAME_SAMPLES)
    stats.observe(frame(10, 0))
    // 11..14 never arrived.
    stats.observe(frame(15, 5 * FRAME_SAMPLES))

    expect(stats.gaps).toBe(1)
    expect(stats.missing).toBe(4)
  })

  it('counts duplicates and out-of-order packets separately from gaps', () => {
    const stats = new StreamStats(FRAME_SAMPLES)
    stats.observe(frame(10, 0))
    stats.observe(frame(10, FRAME_SAMPLES)) // duplicate
    stats.observe(frame(9, 2 * FRAME_SAMPLES)) // behind

    expect(stats.duplicates).toBe(1)
    expect(stats.outOfOrder).toBe(1)
    expect(stats.gaps).toBe(0)
  })

  // The sequence number is 16 bits. Comparing it as an integer would report one
  // enormous gap here instead of a clean wrap.
  it('sees a sequence wrap as contiguous', () => {
    const stats = new StreamStats(FRAME_SAMPLES)
    stats.observe(frame(65534, 0))
    stats.observe(frame(65535, FRAME_SAMPLES))
    stats.observe(frame(0, 2 * FRAME_SAMPLES))
    stats.observe(frame(1, 3 * FRAME_SAMPLES))

    expect(stats.gaps).toBe(0)
    expect(stats.missing).toBe(0)
    expect(stats.outOfOrder).toBe(0)
  })

  it('counts a gap that spans the wrap', () => {
    const stats = new StreamStats(FRAME_SAMPLES)
    stats.observe(frame(65534, 0))
    // 65535 and 0 never arrived.
    stats.observe(frame(1, 3 * FRAME_SAMPLES))

    expect(stats.gaps).toBe(1)
    expect(stats.missing).toBe(2)
  })

  it('flags a timestamp step that is not exactly one frame', () => {
    const stats = new StreamStats(FRAME_SAMPLES)
    stats.observe(frame(0, 0))
    stats.observe(frame(1, FRAME_SAMPLES))
    stats.observe(frame(2, FRAME_SAMPLES * 3)) // a step of two frames

    expect(stats.clockJumps).toBe(1)
  })

  // The timestamp is 32 bits and counts samples, so it wraps roughly every
  // 24 hours at 48 kHz. The step must still read as exactly one frame.
  it('handles a timestamp wrap', () => {
    const stats = new StreamStats(FRAME_SAMPLES)
    stats.observe(frame(0, 0xffffffff - FRAME_SAMPLES + 1))
    stats.observe(frame(1, 0))

    expect(stats.clockJumps).toBe(0)
  })

  it('counts the flags it is told about', () => {
    const stats = new StreamStats(FRAME_SAMPLES)
    stats.observe(frame(0, 0, Flag.Silence | Flag.Underrun))
    stats.observe(frame(1, FRAME_SAMPLES, Flag.Catchup))
    stats.observe(frame(2, 2 * FRAME_SAMPLES, Flag.Discontinuity))

    expect(stats.silence).toBe(1)
    expect(stats.catchup).toBe(1)
    expect(stats.discontinuity).toBe(1)
  })

  it('turns packets into a duration using the sample rate', () => {
    const stats = new StreamStats(FRAME_SAMPLES)
    stats.sampleRate = 48000
    for (let i = 0; i < 50; i++) stats.observe(frame(i, i * FRAME_SAMPLES))

    // 50 packets of 960 samples at 48 kHz is one second of audio.
    expect(stats.summary().audio).toBeCloseTo(1.0, 5)
  })
})

describe('deinterleave', () => {
  it('splits 16-bit samples into channels', () => {
    // Two frames, two channels: L=1000 R=-1000, then L=0 R=32767.
    const bytes = new Uint8Array(8)
    const view = new DataView(bytes.buffer)
    view.setInt16(0, 1000, true)
    view.setInt16(2, -1000, true)
    view.setInt16(4, 0, true)
    view.setInt16(6, 32767, true)

    const { channels, frames } = deinterleave(bytes, 2, 2)

    expect(frames).toBe(2)
    expect(channels).toHaveLength(2)
    expect(channels[0]![0]).toBeCloseTo(1000 / 32768, 6)
    expect(channels[1]![0]).toBeCloseTo(-1000 / 32768, 6)
    expect(channels[0]![1]).toBe(0)
    expect(channels[1]![1]).toBeCloseTo(32767 / 32768, 6)
  })

  it('reads 32-bit floats', () => {
    const bytes = new Uint8Array(8)
    const view = new DataView(bytes.buffer)
    view.setFloat32(0, 0.5, true)
    view.setFloat32(4, -0.25, true)

    const { channels, frames } = deinterleave(bytes, 1, 4)

    expect(frames).toBe(2)
    expect(channels[0]![0]).toBeCloseTo(0.5, 6)
    expect(channels[0]![1]).toBeCloseTo(-0.25, 6)
  })

  it('ignores a trailing partial frame', () => {
    // Five bytes cannot hold a stereo 16-bit frame.
    const { frames } = deinterleave(new Uint8Array(5), 2, 2)
    expect(frames).toBe(1)
  })

  it('produces the full payload length for the default format', () => {
    // 20 ms of 48 kHz stereo as the server sends it.
    const { channels, frames } = deinterleave(new Uint8Array(960 * 2 * 2), 2, 2)
    expect(frames).toBe(960)
    expect(channels[0]!.length).toBe(960)
  })
})
