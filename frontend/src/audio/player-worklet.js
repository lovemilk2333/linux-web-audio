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
 *   - A buffer that still runs dry is filled with silence rather than stalling,
 *     and the underrun is counted. The audio clock cannot wait for the network.
 *   - A buffer that grows makes latency grow with it. Past a high water mark
 *     the oldest audio is discarded, which trades a click for bounded delay.
 *
 * This must stay a plain, unbundled file: the browser loads it with
 * audioWorklet.addModule(url), not as part of a bundle.
 */

const DEFAULT_CHANNELS = 2

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
     * Frames owed to the drift corrector, fractional.
     *
     * Negative means the buffer is short and the reader should repeat a frame;
     * positive means it is long and one should be skipped. See the correction
     * at the chunk boundary in process().
     */
    this.correction = 0

    /**
     * How often playback had to stop and rebuild the buffer.
     *
     * Not an error, but worth counting: a rising number means the stream is
     * arriving slower than it plays, which is the one condition this cannot
     * recover from on its own.
     */
    this.refills = 0

    /**
     * Audio-thread time when the buffer last sat below the reserve floor, or
     * 0 if it is currently above it.
     *
     * The early-refill safety net waits for this to stay set for a few tens of
     * milliseconds before stopping playback: a single block below the floor is
     * ordinary burst jitter, not a drain.
     */
    this.lowSince = 0

    /**
     * Audio-thread time of the most recent refill, early or underrun-driven.
     *
     * A cooldown after a rebuild stops a healthy bursty stream from re-arming
     * every few hundred milliseconds — which is what a plain level threshold
     * did, and why that approach was abandoned.
     */
    this.lastRefillAt = 0

    /**
     * One sample waiting to be written at the start of the next block.
     *
     * Repeating a frame needs a free slot in the current output. When a chunk
     * boundary lands exactly on the end of a render quantum there is none, and
     * without this the owed repeat is deferred until some later boundary that
     * happens to fall mid-block — which systematically under-repeats and is
     * why a 20 ms target still dipped to a few milliseconds.
     */
    this.pendingRepeat = null

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
      case 'reset':
        this.queue = []
        this.offset = 0
        this.buffered = 0
        this.underruns = 0
        this.droppedFrames = 0
        this.playedFrames = 0
        this.clipped = 0
        this.refills = 0
        this.lowSince = 0
        this.lastRefillAt = 0
        this.pendingRepeat = null
        this.playing = false
        break
      default:
        break
    }
  }

  /**
   * Changes how much audio to hold, in whichever direction that means.
   *
   * A live source arrives at exactly playback speed, so a buffer below its
   * target never fills on its own: the level is whatever it was. Raising the
   * target therefore has to pause playback until it fills, and lowering it has
   * to discard the difference. Anything else makes the control do nothing in
   * one direction, which is what it did before.
   */
  setTarget(targetMs) {
    this.targetMs = targetMs

    if (this.buffered > this.targetFrames) {
      this.trimTo(this.targetFrames)
      this.playing = true
      return
    }

    // Below the target: stop playing so the buffer can build. Nothing is
    // dropped, so this costs the difference in delay, once.
    this.playing = false
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

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true

    const wanted = output[0].length
    let written = 0
    let peak = 0

    /* Drift correction.
     *
     * The audio device and the capture source are separate clocks, both
     * nominally 48 kHz and actually a few tens of ppm apart. Measured here:
     * 47999.4 frames arrive per second while 48031.4 are played, so the buffer
     * drains a packet every fifteen seconds for as long as the page is open.
     * Queueing cannot fix it — the two sides disagree about how long a second
     * is — so the reader is nudged instead: short buffer, repeat one frame;
     * long buffer, skip one.
     *
     * Spread over a hundred chunk boundaries a second, a single repeated or
     * skipped frame is inaudible. The alternative is a 20 ms dropout every
     * fifteen seconds, which is not.
     *
     * The gain has to be high enough that the steady-state error stays small.
     * At 0.001 the integrator could only sustain the measured ~32 repeated
     * frames/s by sitting at |errorRatio| ≈ 0.67 — one third of the target —
     * so a 100 ms buffer meant ~33 ms and still sawtoothed into underruns.
     * 0.008 puts the same drift at |errorRatio| ≈ 0.08, about 92% of target,
     * which matters most for thin buffers: a 20 ms target with the weaker
     * 0.004 gain still dipped to a few milliseconds and clicked.
     *
     * Below three quarters of the target the shortfall is counted twice, so
     * the reader spends its one-frame-per-boundary budget recovering reserve
     * instead of hovering near empty. That band never stops playback; it only
     * shapes the corrector. */
    const target = Math.max(1, this.targetFrames)
    const ratio = this.buffered / target
    const errorRatio = ratio >= 0.75 ? ratio - 1 : (ratio - 1) * 2
    this.correction = Math.max(-4, Math.min(4, this.correction + errorRatio * wanted * 0.008))

    if (this.idle && this.buffered === 0) {
      for (let channel = 0; channel < output.length; channel++) output[channel].fill(0)
      this.playing = false
      this.pendingRepeat = null
      this.report(wanted)
      return true
    }

    if (!this.playing) {
      if (this.buffered < this.targetFrames) {
        // Still filling. Output silence, but do not count it as a dropout:
        // nothing has been dropped and nothing is late.
        for (let channel = 0; channel < output.length; channel++) output[channel].fill(0)
        this.pendingRepeat = null
        this.report(wanted)
        return true
      }
      this.playing = true
    }

    if (this.pendingRepeat && written < wanted) {
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][written] = this.pendingRepeat[Math.min(channel, this.pendingRepeat.length - 1)]
      }
      written += 1
      this.correction = Math.min(4, this.correction + 1)
      this.pendingRepeat = null
    }

    while (written < wanted && this.queue.length > 0) {
      const head = this.queue[0]
      const available = head[0].length - this.offset
      const take = Math.min(available, wanted - written)

      const unity = this.gain === 1

      for (let channel = 0; channel < output.length; channel++) {
        // Mono into a stereo output duplicates rather than leaving a silent
        // channel.
        const source = head[Math.min(channel, head.length - 1)]
        const destination = output[channel]

        if (unity) {
          destination.set(source.subarray(this.offset, this.offset + take), written)
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
          destination[written + i] = sample
        }
      }

      // Metered from channel 0 of the output, which is post-gain and post-clamp
      // — exactly what reaches the speakers.
      for (let i = 0; i < take; i++) {
        const sample = Math.abs(output[0][written + i])
        if (sample > peak) peak = sample
      }

      this.offset += take
      this.buffered -= take
      written += take
      this.playedFrames += take

      if (this.offset >= head[0].length) {
        this.queue.shift()
        this.offset = 0

        /* At most one frame of correction per boundary, which bounds the
         * artefact rate no matter how wrong the level is. A owed repeat that
         * finds the block already full is deferred to the next block rather
         * than dropped — otherwise boundaries that land on a quantum edge
         * silently refuse to correct. */
        if (this.correction >= 1 && this.queue.length > 0 && this.queue[0][0].length > 1) {
          this.offset = 1
          this.buffered -= 1
          this.correction -= 1
        } else if (this.correction <= -1 && written > 0) {
          if (written < wanted) {
            for (let channel = 0; channel < output.length; channel++) {
              output[channel][written] = output[channel][written - 1]
            }
            written += 1
            this.correction += 1
          } else if (!this.pendingRepeat) {
            this.pendingRepeat = []
            for (let channel = 0; channel < output.length; channel++) {
              this.pendingRepeat.push(output[channel][written - 1])
            }
          }
        }
      }
    }

    if (written < wanted) {
      // The buffer ran dry mid-block. Play silence for the rest instead of
      // repeating or stalling, and count it.
      for (let channel = 0; channel < output.length; channel++) {
        output[channel].fill(0, written)
      }

      if (written === 0) {
        this.underruns++

        /* The buffer reached nothing, so stop and rebuild it.
         *
         * A live source arrives at exactly playback speed, which means a
         * buffer that has drained can never refill while playing: it stays at
         * zero for the rest of the session and every later packet is late
         * against an output that is already starving. One bad moment would
         * otherwise ratchet the level down permanently.
         *
         * Keyed to an actual dropout rather than to a level. A threshold was
         * the obvious approach and it does not work: packets arrive in bursts
         * while playback drains continuously, so the level swings several
         * milliseconds below the target as a matter of course, and any
         * threshold high enough to catch a drain also catches ordinary jitter.
         * Measured, a guessed threshold re-armed playback every 220 ms on a
         * healthy stream. A dropout is a fact; a level is a guess. */
        this.playing = false
        this.refills++
        this.lastRefillAt = currentTime
        this.lowSince = 0
      }
    }

    /* Early refill safety net.
     *
     * The corrector is what holds the level; this only fires when the buffer
     * has already fallen to about one render quantum (~4 ms) and stayed there
     * for tens of milliseconds. That is far below ordinary burst depth on any
     * sane target, so it does not revive the ~220 ms thrashing of a level
     * threshold near the setpoint. A one-second cooldown after any refill is
     * the other half of that defence. */
    const reserveFloor = Math.max(wanted, Math.round(this.sampleRate * 0.004))
    if (this.playing && this.buffered > 0 && this.buffered < reserveFloor) {
      if (this.lowSince === 0) {
        this.lowSince = currentTime
      } else if (
        currentTime - this.lowSince >= 0.05 &&
        currentTime - this.lastRefillAt >= 1.0
      ) {
        this.playing = false
        this.refills++
        this.lastRefillAt = currentTime
        this.lowSince = 0
      }
    } else {
      this.lowSince = 0
    }

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
      bufferedMs: (this.buffered / this.sampleRate) * 1000,
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
    })

    /* Both reset each report, so they describe the last window rather than
     * everything since the player started. A cumulative clip count would latch
     * the indicator on forever the first time gain was too high — and the
     * useful question is whether it is clipping *now*. */
    this.peak = 0
    this.clipped = 0
  }
}

registerProcessor('webaudio-player', PlayerProcessor)
