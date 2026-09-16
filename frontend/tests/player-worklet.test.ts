// SPDX-License-Identifier: BSD-3-Clause

import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The playback worklet's level control.
 *
 * The worklet is a plain script the browser loads with addModule, so it has no
 * exports and refers to globals the audio thread provides. This file stubs
 * those, loads it, and drives it with a synthetic source on a virtual audio
 * clock.
 *
 * The property under test is the one that decides whether a live stream is
 * listenable: the capture and the audio device are separate clocks, so the
 * reader has to be a little off 1× — and how much is the whole question. Too
 * little and the buffer drains into dropouts; too much, or in steps, and the
 * pitch moves. Whole-sample repeats and skips were tried and removed: against
 * the 695 ppm this machine measures they fired thirty times a second, which is
 * a rasp you can hear. What replaced them is a continuous ratio, and these
 * tests pin how far it is allowed to stray.
 */

const RATE = 48_000
/** The default frame duration: 5 ms. */
const FRAME = 240
/** Web Audio's render quantum. */
const BLOCK = 128
/** The clock mismatch measured against this machine's HDMI output. */
const MEASURED_DRIFT = 695e-6

interface WorkletProcessor {
  idle: boolean
  playing: boolean
  buffered: number
  /** The filtered level the reader steers on, and the panel shows. */
  level: number
  /** How fast it is consuming the stream right now. */
  rate: number
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
 * A synthetic source, feeding a processor on a virtual audio clock.
 *
 * @param deficit how much slower than realtime this source's clock runs, as a
 * fraction. The audio device and the capture source are separate clocks, so
 * this is never exactly zero.
 * @param hz when set, the source is a sine of this frequency rather than
 * silence, which is what makes the output's pitch measurable.
 */
class Source {
  readonly output: number[] = []
  /** The raw queue level, once per render block: a sawtooth by one packet. */
  readonly levels: number[] = []
  /** The filtered level, which is what the reader steers on. */
  readonly shown: number[] = []
  /** The rate the reader used for each block. */
  readonly rates: number[] = []
  private virtual = 0
  private next = 0
  private value = 0

  constructor(private p: WorkletProcessor, private deficit = 0, private hz = 0) {}

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
      this.rates.push(this.p.rate)
    }
  }

  private deliver(): void {
    const chunk = new Float32Array(FRAME)
    for (let i = 0; i < FRAME; i++) {
      chunk[i] = this.hz === 0 ? 0 : Math.sin((2 * Math.PI * this.hz * this.value) / RATE)
      this.value++
    }
    this.p.port.onmessage({ data: { type: 'samples', channels: [chunk] } })
    this.next += FRAME * (1 + this.deficit)
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function tail<T>(values: readonly T[], fraction = 0.5): T[] {
  return values.slice(Math.floor(values.length * fraction))
}

/**
 * The frequency of a sine in the output, from its positive-going zero
 * crossings. Linear interpolation keeps the waveform smooth, so this counts
 * whole cycles exactly.
 */
function frequencyOf(output: readonly number[], seconds: number): number {
  const from = output.length - Math.floor(seconds * RATE)
  let crossings = 0
  let firstAt = -1
  let lastAt = -1
  for (let i = from + 1; i < output.length; i++) {
    if (output[i - 1]! <= 0 && output[i]! > 0) {
      if (firstAt < 0) firstAt = i
      lastAt = i
      crossings++
    }
  }
  if (crossings < 2) return 0
  return ((crossings - 1) * RATE) / (lastAt - firstAt)
}

const msOf = (frames: number) => (frames / RATE) * 1000

describe('playback worklet', () => {
  // 8 seconds at 48 kHz with 5 ms packets: the level sawtooths by one packet,
  // because that is the granularity audio arrives in.
  it('holds a 20 ms target, and holds it on 1×', () => {
    const p = processor(20)
    const source = new Source(p)
    source.run(8)

    expect(p.underruns, 'dropouts').toBe(0)
    expect(p.droppedFrames, 'audio discarded').toBe(0)

    // Steered *to* the target, not merely below it: an integral loop with too
    // little gain settles short of the setpoint instead — measured, 78% of a
    // 20 ms target, which is what this pins down.
    const target = Math.round((20 * RATE) / 1000)
    const level = mean(tail(source.shown, 0.4))
    expect(msOf(level), 'level').toBeGreaterThan(msOf(target) - 1)
    expect(msOf(level), 'level').toBeLessThan(msOf(target) + 1)

    // And with the clocks matched, the reader has nothing to correct: the rate
    // stays within a few hundred ppm of unity, which is under a cent of pitch.
    for (const rate of tail(source.rates, 0.4)) {
      expect(Math.abs(rate - 1), `rate ${rate}`).toBeLessThan(0.001)
    }
  })

  // The measured clock mismatch on the development machine: the capture runs a
  // few hundred ppm slow, so the buffer drains for as long as the page is
  // open. The reader has to hold it up by itself — nothing else will — and the
  // way it does that has to stay inaudible.
  it('holds a slow source with a rate nobody could hear', () => {
    const p = processor(20)
    const source = new Source(p, MEASURED_DRIFT)
    source.run(10)

    expect(p.underruns, 'dropouts from an unheld drift').toBe(0)
    expect(p.droppedFrames, 'audio discarded').toBe(0)

    // The level stays on the target: holding a rate costs a steady error in
    // the direction of the correction, and at this gain that is about a
    // millisecond.
    const target = Math.round((20 * RATE) / 1000)
    const level = mean(tail(source.shown, 0.4))
    expect(msOf(level), 'level').toBeGreaterThan(msOf(target) - 2)
    expect(msOf(level), 'level').toBeLessThan(msOf(target) + 1)

    // The rate is what absorbs the drift, so it settles just under 1 — the
    // source is slow, so the reader plays slow — and it stays there.
    const rates = tail(source.rates, 0.4)
    const settled = mean(rates)
    expect(settled, 'settled rate').toBeGreaterThan(1 - MEASURED_DRIFT * 2)
    expect(settled, 'settled rate').toBeLessThan(1 - MEASURED_DRIFT * 0.5)

    // Whatever it is, it is a couple of cents and it moves by less than a
    // hundredth of a cent between blocks: a speed change, if it can be called
    // that, that nothing can hear.
    for (const rate of rates) {
      expect(Math.abs(rate - 1), `rate ${rate}`).toBeLessThan(0.003)
    }
    for (let i = 1; i < rates.length; i++) {
      expect(Math.abs(rates[i]! - rates[i - 1]!), 'step between blocks').toBeLessThan(1e-4)
    }
  })

  // The pitch is the thing being protected: a reader that corrects by
  // resampling pays for it in pitch, so the question is only how much. A
  // thousand hertz has to come out a thousand hertz, to within a couple of
  // cents, even while the drift is being absorbed.
  it('keeps a tone on pitch while absorbing the drift', () => {
    const p = processor(20)
    const source = new Source(p, MEASURED_DRIFT, 1000)
    source.run(6)

    const hz = frequencyOf(source.output, 4)
    expect(hz, 'frequency of a 1 kHz tone').toBeGreaterThan(1000 * (1 - 2e-3))
    expect(hz, 'frequency of a 1 kHz tone').toBeLessThan(1000 * (1 + 2e-3))
  })

  // The other direction: a source that runs fast pushes the level up, and the
  // reader has to consume faster than it arrives. It must not take the other
  // road and trim — a drop is not audio that went missing, and the hole it
  // leaves reads as a shortfall the reader then fills back in.
  it('holds a fast source by playing up, and never trims to do it', () => {
    const p = processor(20)
    const source = new Source(p, -MEASURED_DRIFT)
    source.run(10)

    expect(p.droppedFrames, 'audio discarded').toBe(0)
    expect(p.underruns, 'dropouts').toBe(0)

    const settled = mean(tail(source.rates, 0.4))
    expect(settled, 'settled rate').toBeGreaterThan(1 + MEASURED_DRIFT * 0.5)
    expect(settled, 'settled rate').toBeLessThan(1 + MEASURED_DRIFT * 2)
  })

  // A stall empties the buffer. The old reader stopped and rebuilt, which
  // turns a 3 ms hole into a whole target of silence; this one keeps playing
  // and pays for the refill in speed.
  it('keeps playing through a stall and refills', () => {
    const p = processor(20)
    const source = new Source(p)
    const target = Math.round((20 * RATE) / 1000)

    source.run(2)
    expect(p.playing).toBe(true)
    source.run(4, [2 * RATE, 2 * RATE + Math.round(0.3 * RATE)])

    expect(p.refills, 'playback stopped to rebuild').toBe(0)
    expect(p.playing, 'still playing once the source came back').toBe(true)
    expect(p.underruns, 'the stall was noticed').toBeGreaterThan(0)

    // Recovering is what the cap is for: it is allowed to be quick, and it is
    // still bounded.
    for (const rate of source.rates) {
      expect(rate, `rate ${rate}`).toBeGreaterThan(1 - 0.031)
      expect(rate, `rate ${rate}`).toBeLessThan(1 + 0.031)
    }

    // And the level climbed back rather than sitting at nothing.
    expect(mean(tail(source.shown, 0.1))).toBeGreaterThan(target * 0.6)
  })

  // A reconnect flushes the queue, and the ring still holds the last session's
  // audio. Preroll must wait for the target in silence: repeating the previous
  // session before anything new has arrived is a stutter, not a fill.
  it('waits for the target after a flush even with looping on', () => {
    const p = processor(20, { loopOnUnderrun: true })
    // A tone, so silence in the output means silence and not a silent source.
    const source = new Source(p, 0, 1000)
    source.run(2)
    expect(p.loops, 'looping was used while playing normally').toBe(0)

    p.port.onmessage({ data: { type: 'flush' } })
    p.port.onmessage({ data: { type: 'idle', idle: true } })
    p.idle = false

    const before = source.output.length
    source.run(1)

    expect(p.loops, 'a flushed buffer was filled by looping').toBe(0)

    // The first blocks after the flush are silence: there is nothing to play
    // until the target has built up again.
    const afterFlush = source.output.slice(before)
    const target = Math.round((20 * RATE) / 1000)
    let silentBlocks = 0
    for (let b = 0; b < 40; b++) {
      const block = afterFlush.slice(b * BLOCK, (b + 1) * BLOCK)
      if (!block.every((sample) => sample === 0)) break
      silentBlocks++
    }
    expect(silentBlocks, 'silent blocks before audio resumed').toBeGreaterThan(0)
    expect(silentBlocks * BLOCK).toBeLessThanOrEqual(target + BLOCK)
  })

  it('stays silent while idle, whatever is queued', () => {
    const p = processor(20, { loopOnUnderrun: true })
    const source = new Source(p, 0, 1000)
    source.run(1)

    p.port.onmessage({ data: { type: 'idle', idle: true } })
    const before = source.output.length
    source.run(0.5)

    const idle = source.output.slice(before)
    expect(idle.every((sample) => sample === 0), 'idle output was not silent').toBe(true)
    expect(p.loops, 'idle output was filled by looping').toBe(0)
  })
})
