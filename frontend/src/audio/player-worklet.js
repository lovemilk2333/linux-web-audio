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
 *   - The reader follows the target by a hair's breadth of speed, and never by
 *     stepping. The audio device and the capture source are separate clocks —
 *     measured against this machine's HDMI output, 695 ppm apart — and the
 *     difference has to go somewhere. Whole-sample repeats and skips were tried
 *     first, and removed: one sample duplicated every thirty milliseconds is a
 *     rasp, and it was plainly audible as one. What absorbs the difference now
 *     is a resampling ratio a few hundred parts per million from unity — a
 *     couple of cents of pitch, continuous, and inaudible on its own. The rate
 *     is driven by a filtered level so the packet sawtooth cannot move it, and
 *     capped so that even recovering from a stalled buffer stays bounded.
 *   - A buffer that still runs dry is filled with silence (or, opt-in, a short
 *     loop of what just played) and playback continues. Stopping to rebuild
 *     turns a 3 ms hole into a whole target of silence.
 *
 * This must stay a plain, unbundled file: the browser loads it with
 * audioWorklet.addModule(url), not as part of a bundle.
 */

const DEFAULT_CHANNELS = 2

/**
 * How much of the relative distance to the target becomes a rate error.
 *
 * At 0.05, holding the 695 ppm this machine measures takes a level error of
 * 1.4% of the target — under a millisecond at any target worth setting — and a
 * buffer that has drained completely calls for the full offset below.
 */
const RATE_GAIN = 0.05

/**
 * How far from 1× the reader will go.
 *
 * ±3% is 50 cents, which is a lot to hear and is only ever reached while
 * recovering from a drained buffer — where the alternative is silence. In
 * steady state the rate sits within a few hundred ppm of unity, which is a
 * couple of cents, which is nothing.
 */
const MAX_RATE_OFFSET = 0.03

/**
 * How much of each new measurement the level takes, per packet.
 *
 * The level is not smooth: five milliseconds of audio lands at once while
 * playback drains continuously, so the raw queue sawtooths by a whole packet.
 * Feeding that straight to the rate is what makes a resampling reader warble
 * — which is why the level is measured *at* the arrivals, where the sawtooth's
 * phase is known and can be subtracted off (see sampleLevel), and then
 * smoothed over a few packets on top of that for the jitter that is left.
 *
 * A quarter per packet is about 20 ms — four packets — which is slow enough to
 * be steady and fast enough that a real change in the level is not missed.
 */
const LEVEL_ALPHA = 0.25

/**
 * Time constant of the rate filter, in seconds.
 *
 * The rate is what the ear would hear as pitch, so it is smoothed on top of
 * the level: whatever wobble is left in the level after the arrival sampling,
 * the speed the reader actually plays at moves by a fraction of it per block.
 * That is the whole point of this design — the correction is continuous by
 * construction, not merely small.
 */
const RATE_TAU = 0.08

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
     * How fast the reader is consuming the source right now, as a fraction of
     * realtime. See playbackRate().
     */
    this.rate = 1

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
    /** Whole-sample read offset into queue[0]. */
    this.offset = 0
    /** Fractional read position in 0..1, on top of `offset`. */
    this.frac = 0
    /** Frames queued and not yet played. */
    this.buffered = 0

    /**
     * The level the reader steers and the panel shows: the queue measured at
     * each arrival, half a packet subtracted, and smoothed. See sampleLevel.
     *
     * The raw queue is a sawtooth — five milliseconds of audio arrives at once
     * and drains continuously — and neither the reader nor the person watching
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
        this.frac = 0
        this.buffered = 0
        this.level = 0
        this.playing = false
        this.looping = false
        break
      case 'reset':
        this.queue = []
        this.offset = 0
        this.frac = 0
        this.buffered = 0
        this.level = 0
        this.underruns = 0
        this.droppedFrames = 0
        this.playedFrames = 0
        this.clipped = 0
        this.refills = 0
        this.rate = 1
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
   * The setpoint the rate is measured against. Lowering it discards the extra
   * so the latency actually falls. Raising it is the interesting direction: a
   * live source cannot fill a buffer while playback consumes it at the same
   * rate, and the reader's rate is allowed a few percent at most, so a real
   * jump would take seconds. Past a few milliseconds of shortfall, playback
   * stops and the buffer builds at the source's own rate instead: that is as
   * fast as the audio can arrive.
   */
  setTarget(targetMs) {
    this.targetMs = targetMs

    if (this.buffered > this.targetFrames) {
      this.trimTo(this.targetFrames)
      return
    }
    if (this.buffered < this.targetFrames - Math.round(this.sampleRate * 0.01)) {
      this.playing = false
    }
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
    const before = this.buffered
    while (this.queue.length > 1 && this.buffered - this.headRemaining() >= limitFrames) {
      this.dropHead()
    }
    if (this.buffered === before) return

    /* A drop is deliberate — latency being taken back off, not audio that went
     * missing. Re-baselining keeps the reader from reading the hole as a
     * shortfall and spending seconds of slow playback filling it back in. */
    this.level = this.buffered
    this.frac = 0
  }

  enqueue(channels) {
    if (!channels || channels.length === 0 || channels[0].length === 0) return

    const arrived = channels[0].length
    this.queue.push(channels)
    this.enqueuedFrames += arrived
    this.buffered += arrived
    this.sampleLevel(arrived)
    this.trim(arrived)
  }

  /**
   * Folds a fresh packet into the level estimate.
   *
   * Called the moment a packet lands, which is the one instant the sawtooth's
   * phase is known: the queue is at its peak, exactly half a packet above the
   * level it is draining around. Subtracting that half packet gives the mean
   * for free, where filtering the raw queue only ever attenuated the sawtooth
   * — measured, a rate that still rippled by 0.3%, which is a warble.
   */
  sampleLevel(arrived) {
    const mean = this.buffered - arrived / 2
    this.level += (mean - this.level) * LEVEL_ALPHA
  }

  /**
   * Discards the oldest audio when the buffer is well over the target.
   *
   * This is for a backlog — a resume replay, a prefill — and the margin has to
   * clear the sawtooth, which swings by a whole packet however the reader
   * plays. A margin of one packet puts the threshold on the peak of that
   * swing, so ordinary jitter trips it. Measured with the margin that tight,
   * against a 16 ms target: a packet dropped every 300 ms, for as long as the
   * stream ran. Half the target, or one packet, whichever is more, is clear of
   * the swing and still bounds latency.
   *
   * This is what keeps the audio current after a resume, when the server
   * replays the missed backlog in one burst: without it, the client would sit
   * behind by however long the connection was down.
   */
  trim(arrived) {
    const allowance = Math.max(arrived, Math.round(this.targetFrames / 2))
    if (this.buffered <= this.targetFrames + allowance) return
    this.trimTo(this.targetFrames)
  }

  /**
   * How fast to consume the source, from the distance to the target.
   *
   * A live source arrives at 1×, so a reader that always plays at exactly 1×
   * has no way to correct a level that has slipped — and the two clocks are
   * never exactly the same. This is the correction: a ratio a whisker away
   * from unity, which is a whisker of pitch, applied continuously rather than
   * in steps. Against the 695 ppm this machine measures, it settles 1.4% below
   * the target and holds there.
   */
  playbackRate() {
    const target = Math.max(1, this.targetFrames)
    const error = ((this.level - target) / target) * RATE_GAIN
    return 1 + Math.max(-MAX_RATE_OFFSET, Math.min(MAX_RATE_OFFSET, error))
  }

  /** Fills a stretch of every channel with silence. */
  silence(output, from, count) {
    for (let channel = 0; channel < output.length; channel++) {
      output[channel].fill(0, from, from + count)
    }
  }

  /** Source sample `index` frames ahead of the current whole-sample offset. */
  sampleAt(channel, index) {
    let skip = index
    for (let q = 0; q < this.queue.length; q++) {
      const chunk = this.queue[q]
      const start = q === 0 ? this.offset : 0
      const length = chunk[0].length - start
      if (skip < length) {
        return chunk[Math.min(channel, chunk.length - 1)][start + skip]
      }
      skip -= length
    }
    return 0
  }

  /** Drops `count` whole source frames from the head of the queue. */
  consume(count) {
    let left = count
    while (left > 0 && this.queue.length > 0) {
      const available = this.queue[0][0].length - this.offset
      const take = Math.min(available, left)
      this.offset += take
      this.buffered -= take
      left -= take
      if (this.offset >= this.queue[0][0].length) {
        this.queue.shift()
        this.offset = 0
      }
    }
    if (this.buffered < 0) this.buffered = 0
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true

    const wanted = output[0].length

    if (this.idle) {
      // Silence, even if something is still queued. A reconnect flushes the
      // queue first; looping leftover audio here is the stutter the loop
      // option is not for.
      this.silence(output, 0, wanted)
      this.playing = false
      this.looping = false
      this.rate = 1
      this.report(wanted)
      return true
    }

    if (!this.playing) {
      if (this.buffered < this.targetFrames) {
        // Preroll. Silence even when looping is on: the ring holds the last
        // session's audio, and repeating it before anything new has arrived
        // is the reconnect bug.
        this.silence(output, 0, wanted)
        this.rate = 1
        this.report(wanted)
        return true
      }
      this.playing = true
      // Start the filter on the level it will be steering, rather than
      // winding up from zero and reading as a shortfall.
      this.level = this.buffered
      this.frac = 0
    }

    const wantedRate = this.playbackRate()
    const rateAlpha = Math.min(1, wanted / (RATE_TAU * this.sampleRate))
    this.rate += (wantedRate - this.rate) * rateAlpha
    const rate = this.rate

    let written = 0
    let peak = 0
    const unity = this.gain === 1

    while (written < wanted && this.buffered >= 1) {
      const t = this.frac
      // The sample after this one, unless this is the last one left — in
      // which case holding the last value beats interpolating toward a zero
      // that was never there.
      const haveNext = this.buffered >= 2

      for (let channel = 0; channel < output.length; channel++) {
        // Mono into a stereo output duplicates rather than leaving a silent
        // channel.
        const s0 = this.sampleAt(channel, 0)
        const s1 = haveNext ? this.sampleAt(channel, 1) : s0
        let sample = s0 + (s1 - s0) * t

        if (!unity) {
          /* Clamped rather than left to wrap or overflow. The Web Audio output
           * would clamp anyway; doing it here means the meter below and the
           * clip count describe the samples that are really played. */
          sample *= this.gain
          if (sample > 1) {
            sample = 1
            this.clipped++
          } else if (sample < -1) {
            sample = -1
            this.clipped++
          }
        }
        output[channel][written] = sample
      }

      // Metered from channel 0 of the output, which is post-gain and
      // post-clamp — exactly what reaches the speakers.
      const heard = Math.abs(output[0][written])
      if (heard > peak) peak = heard

      this.frac += rate
      const whole = Math.floor(this.frac)
      if (whole > 0) {
        this.frac -= whole
        this.consume(whole)
      }

      written += 1
    }

    if (written > 0) {
      // What actually reached the output from the stream. Counted here rather
      // than where the queue is read, because the two differ by whatever the
      // rate is doing — and the counter is how played + dropped + queued is
      // checked against everything enqueued.
      this.playedFrames += written
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
       * A live source arrives at 1×, so a buffer that has drained cannot
       * refill by waiting — it refills by playing slow, which is what the rate
       * does once the level reads as short. Stopping to rebuild instead would
       * turn this hole into a whole target of silence. */
      this.frac = 0
    }

    /* An empty queue is the one measurement that needs no interpretation:
     * nothing is draining, so the level is nothing. Everything else is
     * sampled at the arrivals, where the sawtooth's phase is known. */
    if (this.buffered === 0) this.level = 0

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
      rate: this.rate,
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
