// SPDX-License-Identifier: BSD-3-Clause

import type { StreamFormat } from './decoder'
/* Imported as a URL rather than kept in public/ so Vite fingerprints it.
 *
 * A worklet under a fixed name is a protocol with no version: the page and the
 * audio thread exchange messages, and a browser that keeps the old file from
 * cache pairs a new page with an old worklet. Unknown messages are ignored —
 * silently, since there is nothing else a processor can do with them — so the
 * only symptom is a control that does nothing. */
import workletUrl from './player-worklet.js?url'

/** The playback buffer's own view of the world, reported from the audio thread. */
export interface PlayerStatus {
  /** Audio queued and not yet played, in milliseconds (filtered; see the worklet). */
  bufferedMs: number
  /** The same queue, raw: frames queued and not yet played. */
  bufferedFrames: number
  /** Times the buffer ran dry. */
  underruns: number
  /** Frames discarded to keep latency bounded. */
  droppedFrames: number
  /** Loudest sample since the last report, 0..1. */
  peak: number
  /** Whether the last block was entirely silent. */
  silent: boolean
  /** False while the buffer is still filling to the target. */
  playing: boolean
  /** Audio played since the player started, in milliseconds. */
  playedMs: number
  /** The target the audio thread is actually holding, in milliseconds. */
  targetMs: number
  /** Linear playback gain currently applied. */
  gain: number
  /** Samples clamped at full scale in the last report window (~100 ms). */
  clipped: number
  /** Times playback stopped to rebuild a buffer that had drained. */
  refills: number
  /* Rates, for diagnosing buffer drift: a source and a sink a few tens of ppm
   * apart drain the buffer forever, and the two numbers are how that is told
   * apart from the stream simply arriving slowly. */
  enqueuedFrames: number
  playedFrames: number
  contextRate: number
  streamRate: number
  /**
   * Samples the reader owes the target: negative is short and being paid in
   * repeated samples, positive is long and being paid in skipped ones. Near
   * zero when the level is where it should be.
   */
  correction: number
  /** Times a drained buffer was filled by looping recent audio. */
  loops: number
}

const IDLE_STATUS: PlayerStatus = {
  bufferedMs: 0,
  bufferedFrames: 0,
  underruns: 0,
  droppedFrames: 0,
  peak: 0,
  silent: true,
  playing: false,
  playedMs: 0,
  targetMs: 0,
  gain: 1,
  clipped: 0,
  refills: 0,
  enqueuedFrames: 0,
  playedFrames: 0,
  contextRate: 0,
  streamRate: 0,
  correction: 0,
  loops: 0,
}

/**
 * Owns the AudioContext and the worklet that actually plays.
 *
 * The page's job is only to decode and hand over samples. Everything about
 * when they are heard happens in the worklet, on the audio thread.
 */
export class Player {
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private status: PlayerStatus = { ...IDLE_STATUS }
  private listeners = new Set<(status: PlayerStatus) => void>()
  /** Set once the running worklet is found to be older than this page. */
  private staleWorkletReported = false

  /** True once the audio graph is running. */
  get running(): boolean {
    return this.context !== null && this.context.state === 'running'
  }

  get sampleRate(): number | null {
    return this.context?.sampleRate ?? null
  }

  onStatus(listener: (status: PlayerStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Creates the audio graph. Must be called from a user gesture: browsers
   * refuse to start audio otherwise.
   *
   * @returns the rate the context actually runs at, which may differ from the
   * stream's if the browser declined to resample.
   */
  async start(format: StreamFormat, targetMs: number): Promise<number> {
    await this.stop()

    let context: AudioContext
    try {
      // Asking for the stream's rate lets the browser resample the output. A
      // context at the hardware rate would play 48 kHz audio at the wrong
      // speed instead.
      context = new AudioContext({ sampleRate: format.sampleRate })
    } catch {
      context = new AudioContext()
    }

    /* AudioWorklet exists only in a secure context. Over plain HTTP from
     * anywhere but localhost the property is simply absent, and calling
     * addModule on it throws "cannot read properties of undefined" — which
     * says nothing about the actual problem. */
    if (!context.audioWorklet) {
      throw new Error(
        `this page has no AudioWorklet, because ${location.origin} is not a secure context. ` +
          'Browsers provide audio worklets only over https:// or on localhost. ' +
          'Serving the page over plain http:// from another host strips them. See the README.',
      )
    }

    // Resolved against the document so it works from a subpath as well as a
    // domain root. The fingerprint Vite puts in the name is what stops a
    // cached worklet from silently ignoring messages this page sends.
    await context.audioWorklet.addModule(new URL(workletUrl, document.baseURI).href)

    const node = new AudioWorkletNode(context, 'webaudio-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [format.channels],
      processorOptions: {
        channels: format.channels,
        sampleRate: format.sampleRate,
        targetMs,
      },
    })

    node.port.onmessage = (event: MessageEvent) => {
      const message = event.data
      if (message?.type !== 'status') return

      /* A capability this page relies on, absent from the reply. The worklet
       * cannot be the one this build shipped, which in practice means a cached
       * copy — worth saying out loud, because the symptom is otherwise just a
       * control that does nothing. */
      if (message.gain === undefined && !this.staleWorkletReported) {
        this.staleWorkletReported = true
        console.warn(
          'the audio worklet did not report a gain, so it predates this page. ' +
            'It is probably a cached copy: reload with the cache disabled, or rebuild the page ' +
            'so the worklet is served under a new name. Controls it does not understand will do nothing.',
        )
      }
      this.status = {
        bufferedMs: message.bufferedMs,
        bufferedFrames: message.buffered ?? 0,
        underruns: message.underruns,
        droppedFrames: message.droppedFrames,
        peak: message.peak,
        silent: message.silent,
        playing: message.playing === true,
        playedMs: (message.playedFrames / format.sampleRate) * 1000,
        targetMs: message.targetMs ?? 0,
        gain: message.gain ?? 1,
        clipped: message.clipped ?? 0,
        refills: message.refills ?? 0,
        enqueuedFrames: message.enqueuedFrames ?? 0,
        playedFrames: message.playedFrames ?? 0,
        contextRate: message.contextRate ?? 0,
        streamRate: message.streamRate ?? 0,
        correction: message.correction ?? 0,
        loops: message.loops ?? 0,
      }
      for (const listener of this.listeners) listener(this.status)
    }

    node.connect(context.destination)
    await context.resume()

    this.context = context
    this.node = node
    // A fresh graph starts idle until the caller says otherwise.
    node.port.postMessage({ type: 'idle', idle: true })
    return context.sampleRate
  }

  /** Hands decoded audio to the worklet. */
  push(channels: Float32Array[]): void {
    if (!this.node || channels.length === 0) return

    // The buffers are moved rather than copied, so nothing is allocated on the
    // audio thread and the page keeps no reference to what it just sent.
    this.node.port.postMessage({ type: 'samples', channels }, channels.map((c) => c.buffer))
  }

  /** Changes how much audio to hold, trading latency against dropouts. */
  setTargetMs(targetMs: number): void {
    this.node?.port.postMessage({ type: 'target', targetMs })
  }

  /**
   * Sets the playback gain as a linear multiplier.
   *
   * Applied on the audio thread, so it takes effect on the next block rather
   * than after a round trip through the graph.
   */
  setGain(linear: number): void {
    this.node?.port.postMessage({ type: 'gain', gain: linear })
  }

  /**
   * Marks the player as having nothing to play.
   *
   * Without this, every block during a disconnect counts as a dropout, which
   * reads as a fault when it is only the absence of a stream.
   */
  setIdle(idle: boolean): void {
    this.node?.port.postMessage({ type: 'idle', idle })
  }

  /**
   * After playback has started, loop a short stretch of what just played
   * when the buffer runs dry, instead of outputting silence. Off by
   * default. Preroll and reconnect still wait for the target in silence.
   */
  setLoopOnUnderrun(enabled: boolean): void {
    this.node?.port.postMessage({ type: 'loop', enabled })
  }

  /**
   * Drops queued audio without resetting the counters.
   *
   * Used on reconnect so preroll waits for a fresh target instead of
   * splicing the last session onto the server's prefill.
   */
  flush(): void {
    this.node?.port.postMessage({ type: 'flush' })
  }

  /** Clears queued audio and the counters. */
  reset(): void {
    this.node?.port.postMessage({ type: 'reset' })
    this.status = { ...IDLE_STATUS }
  }

  getStatus(): PlayerStatus {
    return this.status
  }

  /** Browsers suspend the context when a tab is hidden; this brings it back. */
  async resume(): Promise<void> {
    if (this.context && this.context.state !== 'running') {
      await this.context.resume()
    }
  }

  async stop(): Promise<void> {
    if (this.node) {
      this.node.port.onmessage = null
      this.node.disconnect()
      this.node = null
    }
    if (this.context) {
      await this.context.close()
      this.context = null
    }
    this.status = { ...IDLE_STATUS }
  }
}
