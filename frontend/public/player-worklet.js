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
        this.targetMs = message.targetMs
        // Apply the new target immediately rather than waiting for the next
        // overflow, so moving the slider has a visible effect.
        this.trim()
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

  enqueue(channels) {
    if (!channels || channels.length === 0 || channels[0].length === 0) return

    this.queue.push(channels)
    this.buffered += channels[0].length
    this.trim()
  }

  /**
   * Discards the oldest audio once the buffer exceeds twice the target.
   *
   * Trimming to exactly the target rather than to the high water mark matters:
   * stopping just below the limit would leave the buffer permanently full, and
   * the next chunk would trim again — a drop on every packet.
   */
  trim() {
    const limit = Math.max(this.targetFrames * 2, this.sampleRate / 2)
    if (this.buffered <= limit) return

    while (this.queue.length > 0 && this.buffered - this.queue[0].length >= this.targetFrames) {
      const dropped = this.queue.shift()
      this.buffered -= dropped[0].length
      this.droppedFrames += dropped[0].length
      this.offset = 0
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true

    const wanted = output[0].length
    let written = 0
    let peak = 0

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
    })
    this.peak = 0
  }
}

registerProcessor('webaudio-player', PlayerProcessor)
