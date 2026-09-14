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

    this.underruns = 0
    this.droppedFrames = 0
    this.playedFrames = 0
    this.peak = 0
    this.silent = true
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

    if (this.idle && this.buffered === 0) {
      for (let channel = 0; channel < output.length; channel++) output[channel].fill(0)
      this.playing = false
      this.report(wanted)
      return true
    }

    if (!this.playing) {
      if (this.buffered < this.targetFrames) {
        // Still filling. Output silence, but do not count it as a dropout:
        // nothing has been dropped and nothing is late.
        for (let channel = 0; channel < output.length; channel++) output[channel].fill(0)
        this.report(wanted)
        return true
      }
      this.playing = true
    }

    while (written < wanted && this.queue.length > 0) {
      const head = this.queue[0]
      const available = head[0].length - this.offset
      const take = Math.min(available, wanted - written)

      for (let channel = 0; channel < output.length; channel++) {
        // Mono into a stereo output duplicates rather than leaving a silent
        // channel.
        const source = head[Math.min(channel, head.length - 1)]
        output[channel].set(source.subarray(this.offset, this.offset + take), written)
      }

      for (let i = 0; i < take; i++) {
        const sample = Math.abs(head[0][this.offset + i])
        if (sample > peak) peak = sample
      }

      this.offset += take
      this.buffered -= take
      written += take
      this.playedFrames += take

      if (this.offset >= head[0].length) {
        this.queue.shift()
        this.offset = 0
      }
    }

    if (written < wanted) {
      // The buffer ran dry mid-block. Play silence for the rest instead of
      // repeating or stalling, and count it.
      for (let channel = 0; channel < output.length; channel++) {
        output[channel].fill(0, written)
      }
      if (written === 0) this.underruns++
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
    })
    this.peak = 0
  }
}

registerProcessor('webaudio-player', PlayerProcessor)
