// SPDX-License-Identifier: BSD-3-Clause

/**
 * Playback buffer.
 *
 * The page decodes packets and posts planar float chunks here; process() is
 * called by the audio thread on its own clock and drains them. Everything about
 * timing lives in this file: the page has no idea how much audio is queued, and
 * the web's own clocks are far too jittery to pace audio.
 *
 * Three things make the difference between "plays" and "plays well":
 *
 *   - Playback waits for the target to accumulate. Starting on the first packet
 *     leaves no margin against a real-time source, so the buffer hovers at zero
 *     and every late packet is heard as a hole.
 *   - Playback runs at 1× and only ever at 1×. Tracking the target by
 *     resampling — reading a little slow when short and a little fast when
 *     long — is a pitch change, and on a 20 ms buffer the level moves enough
 *     for that to be heard as a warble. The distance to the target is paid off
 *     in whole samples instead, a repeat or a skip every few thousand, which
 *     leaves the pitch alone and still lets a drained buffer refill.
 *   - A buffer that still runs dry is filled with silence (or, opt-in, a short
 *     loop of what just played) and playback continues. Stopping to rebuild
 *     turns a 3 ms hole into a whole target of silence.
 *
 * This must stay a plain, unbundled file: the browser loads it with
 * audioWorklet.addModule(url), not as part of a bundle.
 */

const DEFAULT_CHANNELS = 2

/**
 * How much of the distance to the target is added to the debt each block.
 *
 * High, on purpose. The debt is what the reader pays out, so it is also the
 * loop's gain: at the 0.008 this started at, holding the measured ~32 frames a
 * second of clock drift needed the level to sit about 8% under the target at
 * 100 ms — and 22% under it at 20 ms, because an integral loop's residual is
 * proportional to the target, so the same gain that is fine for a long buffer
 * is far too slow for a thin one. Measured at 0.08, the residual is under a
 * millisecond at either size. Nothing else changed: the debt is still paid in
 * whole samples, and still capped per block, so what reaches the ear is the
 * same handful of repeats — they just arrive when the level actually slipped
 * rather than seconds later.
 */
const CORRECTION_GAIN = 0.08

/** Most single-sample corrections to spend in one render block (~3%). */
const MAX_CORRECTIONS_PER_BLOCK = 4

/**
 * Ceiling on the debt, in samples.
 *
 * With a gain this high the debt saturates as soon as the level is meaningfully
 * off, which is what makes recovery fast — but it also means the ceiling is
 * what the reader pays back after the level has already recovered, so it sets
 * the overshoot: 24 samples is half a millisecond. It doubles as the
 * anti-windup for a buffer that has drained completely: without a ceiling, a
 * long stall would leave corrections owed for minutes.
 */
const MAX_OWED = 24

/**
 * Time constant of the level filter, in seconds.
 *
 * The level is not smooth: five milliseconds of audio lands at once while
 * playback drains continuously, so the raw queue sawtooths by a whole packet.
 * Feeding that to the controller makes it react to the sawtooth instead of to
 * the level — which is what forced the gain to be so low before. Filtering over
 * roughly two packets leaves the mean, which is the thing worth controlling.
 */
const LEVEL_TAU = 0.01

class PlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()

    const opts = (options && options.processorOptions) || {}
    this.channels = opts.channels || DEFAULT_CHANNELS
    /** Audio to hold before playing, in milliseconds. This is the latency. */
    this.targetMs = opts.targetMs || 300
    this.sampleRate = opts.sampleRate || sampleRate

    /**
     * Whether enough audio has accumulated to start.
     *
     * Starting the instant the first packet lands leaves no margin: the source
     * is real-time, so the buffer hovers at zero and every late packet punches
     * a hole in the output. Waiting for the target instead costs that much
     * latency once and then plays without gaps.
     */
    this.playing = false

    /**
     * Samples the reader owes the target, fractional.
     *
     * Negative means the buffer is short and the reader owes itself repeats;
     * positive means it is long and owes skips. Integrated from the distance to
     * the target every block — see owe() — and paid one whole sample at a time.
     */
    this.correction = 0

    /**
     * How often playback had to stop and rebuild the buffer.
     *
     * Kept for the status panel. The reader no longer rebuilds, so this stays
     * at zero.
     */
    this.refills = 0

    /**
     * True while there is no stream to play.
     *
     * The audio thread is still called, and would otherwise count every block
     * as a dropout — which is what a deliberate disconnect looks like. Silence
     * with nothing to play is not a fault.
     */
    this.idle = true

    /** Queued chunks, each an array of Float32Array, one per channel. */
    this.queue = []
    /** Read offset into queue[0]. */
    this.offset = 0
    /** Frames queued and not yet played. */
    this.buffered = 0

    /**
     * The same level, filtered. See LEVEL_TAU.
     *
     * This is what the controller steers and what the panel shows. The raw
     * queue is a sawtooth — five milliseconds of audio arrives at once and
     * drains continuously — and neither the reader nor the person watching
     * wants to see that; both want the level underneath it.
     */
    this.level = 0

    /**
     * Playback gain, as a linear multiplier.
     *
     * Applied here rather than through a GainNode so the meter below reads
     * what is actually heard. A node after this one would leave the meter
     * showing pre-gain levels, which is worse than useless when the whole
     * point of the control is that the stream is too quiet or too loud.
     */
    this.gain = 1

    this.underruns = 0
    this.droppedFrames = 0
    this.playedFrames = 0
    this.enqueuedFrames = 0
    this.peak = 0
    this.silent = true
    this.clipped = 0
    this.quantaSinceReport = 0
    this.loops = 0

    /**
     * When true, a drained buffer is filled from a short ring of what just
     * played instead of silence. Off by default: it hides a stall as a
     * stutter rather than a click. Only used after playback has started;
     * preroll waits in silence even when this is on.
     */
    this.loopOnUnderrun = opts.loopOnUnderrun === true
    /** About 40 ms of recently played audio, one plane per channel. */
    this.loopHold = Math.max(128, Math.round(this.sampleRate * 0.04))
    this.loopRing = Array.from({ length: this.channels }, () => new Float32Array(this.loopHold))
    this.loopWrite = 0
    this.loopFilled = 0
    this.loopRead = 0
    /** True while the current dry spell is being filled from the ring. */
    this.looping = false

    this.port.onmessage = (event) => this.receive(event.data)
    this.port.postMessage({ type: 'ready', sampleRate: this.sampleRate, channels: this.channels })
  }

  get targetFrames() {
    return Math.round((this.targetMs * this.sampleRate) / 1000)
  }

  receive(message) {
    if (!message) return

    switch (message.type) {
      case 'samples':
        this.enqueue(message.channels)
        break
      case 'target':
        this.setTarget(message.targetMs)
        break
      case 'gain':
        this.gain = Number.isFinite(message.gain) ? message.gain : 1
        break
      case 'idle':
        this.idle = message.idle === true
        break
      case 'loop':
        this.loopOnUnderrun = message.enabled === true
        break
      case 'flush':
        // Drop leftover audio without touching the counters. A reconnect
        // should wait for a fresh target, not splice the last session onto
        // the prefill.
        this.queue = []
        this.offset = 0
        this.buffered = 0
        this.level = 0
        this.playing = false
        this.looping = false
        this.correction = 0
        break
      case 'reset':
        this.queue = []
        this.offset = 0
        this.buffered = 0
        this.level = 0
        this.underruns = 0
        this.droppedFrames = 0
        this.playedFrames = 0
        this.clipped = 0
        this.refills = 0
        this.correction = 0
        this.playing = false
        this.loops = 0
        this.loopWrite = 0
        this.loopFilled = 0
        this.loopRead = 0
        this.looping = false
        break
      default:
        break
    }
  }

  /**
   * Changes how much audio to hold.
   *
   * The setpoint the debt is measured against. Lowering it discards the extra
   * so latency actually falls; raising it leaves the reader owing repeats,
   * which bring the level up without stopping playback.
   */
  setTarget(targetMs) {
    this.targetMs = targetMs
    if (this.buffered > this.targetFrames) this.trimTo(this.targetFrames)
  }

  /** Frames left in the head chunk that have not been played yet. */
  headRemaining() {
    return this.queue.length === 0 ? 0 : this.queue[0][0].length - this.offset
  }

  /**
   * Drops the oldest chunk, counting only the part that had not been played.
   *
   * `buffered` counts unplayed frames, and a chunk being read from has already
   * had `offset` frames subtracted. Taking the whole length off again drives
   * the count negative, which then never recovers.
   */
  dropHead() {
    const head = this.queue.shift()
    const unplayed = head[0].length - this.offset
    this.buffered -= unplayed
    this.droppedFrames += unplayed
    this.offset = 0
  }

  /** Discards the oldest audio until no more than `limitFrames` remain. */
  trimTo(limitFrames) {
    while (this.queue.length > 1 && this.buffered - this.headRemaining() >= limitFrames) {
      this.dropHead()
    }
  }

  enqueue(channels) {
    if (!channels || channels.length === 0 || channels[0].length === 0) return

    const arrived = channels[0].length
    this.queue.push(channels)
    this.enqueuedFrames += arrived
    this.buffered += arrived
    this.trim(arrived)
  }

  /**
   * Discards the oldest audio when the buffer exceeds the target by more than
   * one chunk.
   *
   * The allowance is one chunk, not a fixed span: chunks are what arrive, so
   * any smaller allowance would trim on every packet. It deliberately does not
   * scale with the target either — an absolute floor here meant a small target
   * was never honoured, and the buffer would grow to the floor before anything
   * was dropped, which is the opposite of what asking for low latency means.
   *
   * This is what keeps the audio current after a resume, when the server
   * replays the missed backlog in one burst: without it, the client would sit
   * behind by however long the connection was down.
   */
  trim(arrived) {
    if (this.buffered <= this.targetFrames + arrived) return
    this.trimTo(this.targetFrames)
  }

  /**
   * Adds this block's distance to the target to the debt.
   *
   * The error is integrated rather than acted on directly: the debt is what
   * carries a correction forward once the level has moved, which is what lets
   * a persistent shortfall — a clock that runs slow, a buffer that drained —
   * be corrected at all rather than merely opposed.
   *
   * What it is measured against is the filtered level, not the raw queue, so
   * the packet sawtooth does not drive it. What comes out is a debt in whole
   * samples, paid by the reader one at a time.
   */
  owe(blockFrames) {
    const target = Math.max(1, this.targetFrames)
    const owed = ((this.level - target) / target) * blockFrames * CORRECTION_GAIN
    this.correction = Math.max(-MAX_OWED, Math.min(MAX_OWED, this.correction + owed))
  }

  /** Fills a stretch of every channel with silence. */
  silence(output, from, count) {
    for (let channel = 0; channel < output.length; channel++) {
      output[channel].fill(0, from, from + count)
    }
  }

  /**
   * Copies up to `count` samples from the head of the queue at 1×.
   *
   * No rate, no interpolation: what was encoded is what comes out, which is
   * what keeps the pitch where it belongs.
   *
   * @returns how many samples were written. Short of `count` means the queue
   * ran out.
   */
  copyOut(output, from, count, unity) {
    let copied = 0
    while (copied < count && this.queue.length > 0) {
      const head = this.queue[0]
      const available = head[0].length - this.offset
      const take = Math.min(available, count - copied)

      for (let channel = 0; channel < output.length; channel++) {
        // Mono into a stereo output duplicates rather than leaving a silent
        // channel.
        const source = head[Math.min(channel, head.length - 1)]
        const destination = output[channel]

        if (unity) {
          destination.set(source.subarray(this.offset, this.offset + take), from + copied)
          continue
        }

        for (let i = 0; i < take; i++) {
          /* Clamped rather than left to wrap or overflow. The Web Audio output
           * would clamp anyway; doing it here means the meter below and the
           * clip count describe the samples that are really played. */
          let sample = source[this.offset + i] * this.gain
          if (sample > 1) {
            sample = 1
            this.clipped++
          } else if (sample < -1) {
            sample = -1
            this.clipped++
          }
          destination[from + copied + i] = sample
        }
      }

      this.offset += take
      this.buffered -= take
      copied += take

      if (this.offset >= head[0].length) {
        this.queue.shift()
        this.offset = 0
      }
    }

    if (this.buffered < 0) this.buffered = 0
    return copied
  }

  /** Drops one source sample without outputting it. */
  skipOne() {
    if (this.queue.length === 0) return
    const head = this.queue[0]
    this.offset++
    this.buffered--
    if (this.offset >= head[0].length) {
      this.queue.shift()
      this.offset = 0
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true

    const wanted = output[0].length

    if (this.idle) {
      // Silence, even if something is still queued. Reconnect flushes first;
      // looping leftover audio here is the stutter that option is not for.
      this.silence(output, 0, wanted)
      this.playing = false
      this.looping = false
      this.correction = 0
      this.report(wanted)
      return true
    }

    if (!this.playing) {
      if (this.buffered < this.targetFrames) {
        // Preroll. Silence even when looping is on: the ring is the last
        // session's audio, and repeating it before anything new has arrived
        // is the reconnect bug.
        this.silence(output, 0, wanted)
        this.correction = 0
        this.report(wanted)
        return true
      }
      this.playing = true
      // Start the filter on the level it will be tracking, rather than
      // winding up from zero and reading as a shortfall.
      this.level = this.buffered
    }

    this.owe(wanted)

    const skipping = this.correction > 0
    let budget = Math.min(MAX_CORRECTIONS_PER_BLOCK, Math.floor(Math.abs(this.correction)))
    let untilDue = budget > 0 ? Math.max(1, Math.floor(wanted / (budget + 1))) : 0

    let written = 0
    let peak = 0
    const unity = this.gain === 1

    while (written < wanted) {
      const limit = budget > 0 ? Math.min(untilDue, wanted - written) : wanted - written
      const copied = this.copyOut(output, written, limit, unity)
      if (copied === 0) break

      // Metered from channel 0 of the output, which is post-gain and
      // post-clamp — exactly what reaches the speakers.
      for (let i = written; i < written + copied; i++) {
        const sample = Math.abs(output[0][i])
        if (sample > peak) peak = sample
      }
      written += copied

      if (budget === 0) continue

      untilDue -= copied
      if (untilDue > 0) continue

      /* One whole sample of the debt, spread evenly through the block rather
       * than taken at a chunk boundary. A boundary only comes round every
       * packet, and at a 5 ms frame that is too seldom to refill a 20 ms
       * buffer in reasonable time. */
      if (skipping) {
        this.skipOne()
        budget--
        this.correction -= 1
      } else if (written < wanted) {
        // Repeating a sample stretches the waveform by one sample. It is a
        // far smaller artefact than a rate change, and it is what buys the
        // buffer time to refill.
        for (let channel = 0; channel < output.length; channel++) {
          output[channel][written] = output[channel][written - 1]
        }
        written++
        budget--
        this.correction += 1
      }

      untilDue = budget > 0 ? Math.max(1, Math.floor((wanted - written) / (budget + 1))) : 0
    }

    if (written > 0) {
      this.captureLoop(output, 0, written)
      this.looping = false
    }

    if (written < wanted) {
      // The buffer ran dry mid-block. Loop a short stretch of what just
      // played when that is enabled and we have any; otherwise silence.
      const remaining = wanted - written
      if (this.loopOnUnderrun && this.loopFilled > 0) {
        this.fillFromLoop(output, written, remaining)
      } else {
        this.silence(output, written, remaining)
      }

      if (written === 0) this.underruns++

      /* Stay playing.
       *
       * A live source arrives at 1×, so a buffer that has drained can never
       * refill by waiting — but it does not have to wait. The debt is already
       * at its ceiling, and the repeats it pays out are what hold playback
       * back until the buffer has climbed again. Stopping to rebuild would
       * turn this hole into a whole target of silence. */
    }

    /* Fold this block into the level estimate.
     *
     * Taken at the end of the block, plus half a block of what was consumed
     * during it, so the sample describes the middle of the block rather than
     * whichever end it was taken from. Steering on an end-of-block sample
     * instead would hold the level half a block below the target — a bias the
     * controller cannot see and so cannot correct. */
    const sampled = this.buffered + wanted / 2
    const alpha = Math.min(1, wanted / (LEVEL_TAU * this.sampleRate))
    this.level += (sampled - this.level) * alpha

    this.peak = Math.max(this.peak, peak)
    this.silent = peak === 0
    this.report(wanted)

    // Keep the processor alive for the life of the page.
    return true
  }

  /**
   * Reports roughly every 100 ms: often enough to animate a meter smoothly,
   * rare enough not to flood the message port.
   */
  report(blockFrames) {
    this.quantaSinceReport++
    if (this.quantaSinceReport * blockFrames < this.sampleRate / 10) return

    this.quantaSinceReport = 0
    this.port.postMessage({
      type: 'status',
      buffered: this.buffered,
      /* The filtered level while playing, so the number does not jump with
       * every packet; the raw queue during preroll, before the filter has
       * anything to track. */
      bufferedMs: ((this.playing ? this.level : this.buffered) / this.sampleRate) * 1000,
      underruns: this.underruns,
      droppedFrames: this.droppedFrames,
      playedFrames: this.playedFrames,
      peak: this.peak,
      silent: this.silent,
      playing: this.playing,
      targetMs: this.targetMs,
      gain: this.gain,
      clipped: this.clipped,
      refills: this.refills,
      correction: this.correction,
      enqueuedFrames: this.enqueuedFrames,
      contextRate: sampleRate,
      streamRate: this.sampleRate,
      loops: this.loops,
    })

    /* Both reset each report, so they describe the last window rather than
     * everything since the player started. A cumulative clip count would latch
     * the indicator on forever the first time gain was too high — and the
     * useful question is whether it is clipping *now*. */
    this.peak = 0
    this.clipped = 0
  }

  /** Fills a dry stretch from the ring, restarting only on a new dry spell. */
  fillFromLoop(output, from, count) {
    if (!this.looping) {
      this.loopRead = 0
      this.looping = true
    }
    this.writeLoop(output, from, count)
    this.loops++
  }

  /** Copies recently played samples into the underrun ring. */
  captureLoop(output, from, count) {
    if (count <= 0) return
    for (let i = 0; i < count; i++) {
      const at = (this.loopWrite + i) % this.loopHold
      for (let channel = 0; channel < this.loopRing.length; channel++) {
        const source = output[Math.min(channel, output.length - 1)]
        this.loopRing[channel][at] = source[from + i]
      }
    }
    this.loopWrite = (this.loopWrite + count) % this.loopHold
    this.loopFilled = Math.min(this.loopHold, this.loopFilled + count)
  }

  /** Fills `count` samples from the ring, wrapping, starting at `from`. */
  writeLoop(output, from, count) {
    const hold = this.loopFilled
    if (hold <= 0) {
      this.silence(output, from, count)
      return
    }
    // Oldest sample is loopWrite - hold. loopRead is an offset into that window.
    const origin = (this.loopWrite - hold + this.loopHold) % this.loopHold
    for (let i = 0; i < count; i++) {
      const src = (origin + ((this.loopRead + i) % hold)) % this.loopHold
      for (let channel = 0; channel < output.length; channel++) {
        const ring = this.loopRing[Math.min(channel, this.loopRing.length - 1)]
        output[channel][from + i] = ring[src]
      }
    }
    this.loopRead = (this.loopRead + count) % hold
  }
}

registerProcessor('webaudio-player', PlayerProcessor)
