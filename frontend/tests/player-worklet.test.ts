// SPDX-License-Identifier: BSD-3-Clause

import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The playback worklet's rate control.
 *
 * The worklet is a plain script the browser loads with addModule, so it has no
 * exports and refers to globals the audio thread provides. This file stubs
 * those, loads it, and drives it with a synthetic 1× source — packets whose
 * sample values count upwards — so what the reader did to the stream can be
 * read straight off the output. A value that appears twice is a repeat, a
 * missing value is a skip, and a value that was never sent is a bug.
 *
 * The property under test is that the level is steered without ever changing
 * speed. Resampling the stream to catch up on the target is a pitch change,
 * and on a 20 ms buffer the level moves enough for that to be heard as a
 * warble — which is what the whole-samples-only rule exists to prevent.
 */

const RATE = 48_000
/** The default frame duration: 5 ms. */
const FRAME = 240
/** Web Audio's render quantum. */
const BLOCK = 128

interface WorkletProcessor {
  idle: boolean
  playing: boolean
  buffered: number
  /** The filtered level the reader steers on, and the panel shows. */
  level: number
  correction: number
  refills: number
  underruns: number
  droppedFrames: number
  loops: number
  port: { onmessage: (event: { data: unknown }) => void }
  process(inputs: unknown[], outputs: Float32Array[][]): boolean
}

let Processor: new (options: { processorOptions: Record<string, unknown> }) => WorkletProcessor

beforeAll(async () => {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.sampleRate = RATE
  globals.currentTime = 0
  globals.AudioWorkletProcessor = class {
    port = { postMessage: () => {}, onmessage: null }
  }
  globals.registerProcessor = (_name: string, processor: unknown) => {
    Processor = processor as typeof Processor
  }

  // Loaded by URL rather than by specifier: the worklet is not a module, and
  // has no types to import.
  const url = new URL('../src/audio/player-worklet.js', import.meta.url).href
  await import(/* @vite-ignore */ url)
})

function processor(targetMs: number, options: Record<string, unknown> = {}): WorkletProcessor {
  const p = new Processor({ processorOptions: { channels: 1, sampleRate: RATE, targetMs, ...options } })
  p.idle = false
  return p
}

/**
 * A synthetic 1× source, feeding a processor on a virtual audio clock.
 *
 * Sample values count up from 1, so they identify themselves in the output.
 * A stall stops delivery for a span of virtual time, the way a main-thread
 * stall or a dropped connection does.
 */
class Source {
  readonly output: number[] = []
  /** The raw queue level, once per render block: a sawtooth by one packet. */
  readonly levels: number[] = []
  /** The filtered level, which is what the reader steers on. */
  readonly shown: number[] = []
  private virtual = 0
  private next = 0
  private value = 0

  /**
   * @param deficit how much slower than real time this source's clock runs,
   * as a fraction. The audio device and the capture source are separate
   * clocks, so this is never exactly zero.
   */
  constructor(private p: WorkletProcessor, private deficit = 0) {}

  /** Runs `seconds` of playback. `stall` is a span of virtual samples. */
  run(seconds: number, stall: [number, number] | null = null): void {
    const blocks = Math.floor((seconds * RATE) / BLOCK)
    for (let b = 0; b < blocks; b++) {
      const stalled = stall !== null && this.virtual >= stall[0] && this.virtual < stall[1]
      if (stalled) {
        // Resuming cleanly: the backlog is not delivered in a burst.
        this.next = this.virtual + FRAME
      } else {
        while (this.virtual >= this.next) this.deliver()
      }

      const out = new Float32Array(BLOCK)
      this.p.process([], [[out]])
      this.virtual += BLOCK

      for (const sample of out) this.output.push(sample)
      this.levels.push(this.p.buffered)
      this.shown.push(this.p.level)
    }
  }

  private deliver(): void {
    const chunk = new Float32Array(FRAME)
    for (let i = 0; i < FRAME; i++) chunk[i] = ++this.value
    this.p.port.onmessage({ data: { type: 'samples', channels: [chunk] } })
    this.next += FRAME * (1 + this.deficit)
  }
}

interface Reading {
  /** Samples the reader repeated: playback was held back. */
  repeated: number
  /** Samples the reader skipped: playback was hurried along. */
  skipped: number
  /** Values that were never sent. Any of these is a bug. */
  invented: number
  /** Samples of silence after playback began: a buffer that ran dry. */
  silence: number
}

/**
 * Reads what the reader did to the stream, sample by sample.
 *
 * The source counts 1, 2, 3, … at 1×, so the output should walk the same
 * sequence. A repeat shows as the same value twice, a skip as a gap — and
 * anything that is neither means the reader made a value up, which is what
 * resampling would look like from here. Zeros before playback starts are
 * preroll and are not counted; zeros after it are dropouts.
 */
function read(output: readonly number[]): Reading {
  let expected: number | null = null
  const reading: Reading = { repeated: 0, skipped: 0, invented: 0, silence: 0 }

  for (const sample of output) {
    if (sample === 0) {
      if (expected !== null) reading.silence++
      continue
    }
    if (expected === null) {
      expected = sample
      continue
    }
    if (sample === expected) {
      reading.repeated++
    } else if (sample === expected + 1) {
      expected = sample
    } else if (sample > expected + 1) {
      reading.skipped += sample - expected - 1
      expected = sample
    } else {
      reading.invented++
      expected = sample
    }
  }

  return reading
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

describe('playback worklet', () => {
  // 8 seconds at 48 kHz with 5 ms packets: the level sawtooths by one packet,
  // because that is the granularity audio arrives in.
  it('holds a 20 ms target at 1× without inventing samples', () => {
    const p = processor(20)
    const source = new Source(p)
    source.run(8)

    const reading = read(source.output)
    expect(reading.invented, 'samples that were never sent').toBe(0)
    expect(reading.silence, 'silence while a full buffer was available').toBe(0)
    expect(p.underruns, 'dropouts').toBe(0)

    // Steered in whole samples, so the deviation from 1× is tiny: a fraction
    // of a percent, against the tens of percent a resampling reader would use.
    const corrections = reading.repeated + reading.skipped
    expect(corrections / source.output.length).toBeLessThan(0.005)

    // And it is steered *to* the target, not merely below it: the level the
    // reader holds is the target, within a fraction of a millisecond. An
    // integral loop with too little gain settles short of the setpoint instead
    // — measured, 78% of a 20 ms target, which is what this pins down.
    const target = Math.round((20 * RATE) / 1000)
    const settled = source.shown.slice(Math.floor(source.shown.length / 2))
    expect(mean(settled)).toBeGreaterThan(target - 0.5 * (RATE / 1000))
    expect(mean(settled)).toBeLessThan(target + 0.5 * (RATE / 1000))

    // The queue underneath still sawtooths, because audio arrives in packets —
    // but around the target, not below it.
    const queue = source.levels.slice(Math.floor(source.levels.length / 2))
    expect(Math.max(...queue)).toBeLessThanOrEqual(target + FRAME)
    expect(Math.min(...queue)).toBeGreaterThan(target - 2 * FRAME)
  })

  // The measured clock mismatch on the development machine: the source's clock
  // runs a few tens of ppm slow, so the buffer drains for as long as the page
  // is open. The reader has to hold it up by itself — nothing else will. The
  // alternative, resampling, would hold it by playing flat.
  it('holds a source whose clock runs slow', () => {
    const p = processor(20)
    const source = new Source(p, 0.00067)
    source.run(8)

    expect(p.underruns, 'dropouts from an unheld drift').toBe(0)
    expect(read(source.output).invented).toBe(0)

    // 30 ppm is about 32 frames a second. Over eight seconds that is 256
    // frames — a quarter of the buffer — which the reader has to give back in
    // repeated samples. It must not let the level go instead: the level stays
    // on the target, and the drift shows up as repeats and nothing else.
    const target = Math.round((20 * RATE) / 1000)
    const after = mean(source.shown.slice(-100))
    expect(after).toBeGreaterThan(target - 0.5 * (RATE / 1000))
    expect(after).toBeLessThan(target + 0.5 * (RATE / 1000))
    expect(read(source.output).repeated, 'samples held back').toBeGreaterThan(100)
  })

  // A source that runs slightly fast pushes the level up, and the reader has
  // to hold it down by skipping samples. It must not take the other road and
  // trim: a drop is not audio that went missing, and the reader would owe
  // itself repeats for it, filling back what was just discarded. Measured
  // with the trim margin set to one packet, against the 20 ms target this
  // runs at: 800 frames a second dropped and 800 repeated, for as long as the
  // stream ran — the audio stumbling, which is what it sounds like.
  it('holds a fast source by skipping, and never trims to do it', () => {
    const p = processor(20)
    const source = new Source(p, -0.006)
    source.run(8)

    expect(p.droppedFrames, 'audio discarded').toBe(0)
    expect(p.underruns, 'dropouts').toBe(0)
    expect(read(source.output).invented).toBe(0)

    // The level settles a little *above* the target, not below it: holding a
    // source back costs a steady error in the direction of the correction —
    // 0.6% of playback is about 73 frames at this gain — and the reader
    // spends it above the setpoint, where the only cost is a millisecond and
    // a half of latency.
    const target = Math.round((20 * RATE) / 1000)
    const after = mean(source.shown.slice(-100))
    expect(after).toBeGreaterThan(target - 0.5 * (RATE / 1000))
    expect(after).toBeLessThan(target + 2.5 * (RATE / 1000))
    // Held back by whole samples, in the direction the level went.
    expect(read(source.output).skipped, 'samples skipped').toBeGreaterThan(100)
  })

  // A stall empties the buffer. The old reader stopped and rebuilt, which
  // turns a 3 ms hole into a whole target of silence; this one keeps playing
  // and pays for the refill in repeated samples.
  it('keeps playing through a stall and refills', () => {
    const p = processor(20)
    const source = new Source(p)
    const target = Math.round((20 * RATE) / 1000)

    source.run(2)
    const playedBefore = p.playing
    source.run(3, [2 * RATE, 2 * RATE + Math.round(0.3 * RATE)])

    expect(playedBefore).toBe(true)
    expect(p.refills, 'playback stopped to rebuild').toBe(0)
    expect(p.playing, 'still playing once the source came back').toBe(true)
    expect(p.underruns, 'the stall was noticed').toBeGreaterThan(0)

    // The recovery is still 1×: repeats, never a rate change.
    expect(read(source.output).invented).toBe(0)

    // And the level climbed back rather than sitting at nothing.
    const recovered = mean(source.levels.slice(-100))
    expect(recovered).toBeGreaterThan(target * 0.6)
  })

  // A reconnect flushes the queue, and the ring still holds the last session's
  // audio. Preroll must wait for the target in silence: repeating the previous
  // session before anything new has arrived is a stutter, not a fill.
  it('waits for the target after a flush even with looping on', () => {
    const p = processor(20, { loopOnUnderrun: true })
    const source = new Source(p)
    source.run(2)
    expect(p.loops, 'looping was used while playing normally').toBe(0)

    p.port.onmessage({ data: { type: 'flush' } })
    p.port.onmessage({ data: { type: 'idle', idle: true } })
    p.idle = false

    const before = source.output.length
    source.run(1)

    const afterFlush = source.output.slice(before)
    expect(p.loops, 'a flushed buffer was filled by looping').toBe(0)

    // The first block after the flush is silence: there is nothing to play
    // until the target has built up again.
    const target = Math.round((20 * RATE) / 1000)
    let buffered = 0
    let silentBlocks = 0
    for (let b = 0; b < 40; b++) {
      const block = afterFlush.slice(b * BLOCK, (b + 1) * BLOCK)
      if (block.every((sample) => sample === 0)) silentBlocks++
      else break
      buffered += BLOCK
    }
    expect(silentBlocks, 'silent blocks before audio resumed').toBeGreaterThan(0)
    expect(buffered).toBeLessThanOrEqual(target + BLOCK)
  })

  it('stays silent while idle, whatever is queued', () => {
    const p = processor(20, { loopOnUnderrun: true })
    const source = new Source(p)
    source.run(1)

    p.port.onmessage({ data: { type: 'idle', idle: true } })
    const before = source.output.length
    source.run(0.5)

    const idle = source.output.slice(before)
    expect(idle.every((sample) => sample === 0), 'idle output was not silent').toBe(true)
    expect(p.loops, 'idle output was filled by looping').toBe(0)
  })
})
