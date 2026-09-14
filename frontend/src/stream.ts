// SPDX-License-Identifier: BSD-3-Clause

import { FrameParser, ProtocolError, seqDistance, seqNext, type Frame } from './audio/protocol'

/** What GET /audio/info reports. */
export interface ServerInfo {
  version: string
  capture_library: string
  codec: string
  codecs: string[]
  sample_rate: number
  channels: number
  frame_samples: number
  frame_duration_ms: number
  bitrate: number
  sink: string
  monitor: string
  current_seq: number
  oldest_seq: number
  history_packets: number
  started: boolean
  subscribers: number
  uptime_seconds: number
  capture_reopens: number
  header_size: number
  timestamp_unit: string
}

export type StreamState = 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'stopped' | 'failed'

/** Why a stream ended, when it was not simply the user pressing stop. */
export interface StreamEvent {
  kind: 'open' | 'closed' | 'gap' | 'notice' | 'error'
  message: string
  /** Set for a gap: how many packets were never delivered. */
  missing?: number
}

export interface StreamOptions {
  baseUrl: string
  codec: string
  token: string
  /** Resume from the last sequence number seen, instead of joining live. */
  resume: boolean
  /**
   * The sequence number to resume after, when the caller already knows it.
   *
   * A reader that reconnects internally remembers this itself, but a caller
   * that tears the reader down and builds a new one — as the page does when
   * the connection is dropped deliberately — has to hand the point over.
   */
  resumeFrom?: number | null
  onFrame: (frame: Frame) => void
  onEvent: (event: StreamEvent) => void
  onState: (state: StreamState) => void
  /** How long to wait before reconnecting, in milliseconds. */
  retryDelayMs?: number
}

export class StreamError extends Error {
  constructor(
    message: string,
    /** The HTTP status, when the failure came from a response. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'StreamError'
  }
}

function normaliseBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function authHeaders(token: string): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Reads a header, returning null rather than throwing when it is absent. */
function headerInt(response: Response, name: string): number | null {
  const raw = response.headers.get(name)
  if (raw === null) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : null
}

/** Reads a response body as text for an error message, defensively. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const body = await response.text()
    const parsed = JSON.parse(body) as { detail?: string }
    return parsed.detail ?? body.slice(0, 200)
  } catch {
    return ''
  }
}

/**
 * Fetches the stream description.
 *
 * Worth calling before connecting: it is what tells the page which codecs the
 * server offers and whether any audio has been produced at all.
 */
export async function fetchInfo(
  baseUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<ServerInfo> {
  const response = await fetch(`${normaliseBase(baseUrl)}/audio/info`, {
    headers: authHeaders(token),
    signal,
  })

  if (!response.ok) {
    const detail = await errorDetail(response)
    throw new StreamError(
      `GET /audio/info returned ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
    )
  }
  return (await response.json()) as ServerInfo
}

/**
 * Reads the stream, reconnecting as needed, until stopped.
 *
 * The resume path is the point of this class. When a connection drops the next
 * one asks for the packet after the last one seen, so the server replays what
 * was missed rather than skipping a hole in the audio. If the server no longer
 * holds that point it answers 416 with the range it does hold, which is
 * reported as a gap rather than silently ignored.
 */
export class StreamReader {
  private controller: AbortController | null = null
  private running = false
  /** The last sequence number actually delivered downstream. */
  private lastSeq: number | null = null
  private attempt = 0

  constructor(private options: StreamOptions) {
    this.lastSeq = options.resumeFrom ?? null
  }

  get lastSequence(): number | null {
    return this.lastSeq
  }

  /** Forgets the resume point, so the next connection joins at the live edge. */
  resetResumePoint(): void {
    this.lastSeq = null
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.controller = new AbortController()

    const { onState, onEvent } = this.options
    const delay = this.options.retryDelayMs ?? 1000

    try {
      while (this.running) {
        onState(this.attempt === 0 ? 'connecting' : 'reconnecting')

        try {
          const ended = await this.readOnce(this.controller.signal)
          if (!this.running) break

          onEvent({ kind: 'closed', message: ended })
        } catch (error) {
          if (!this.running || this.controller.signal.aborted) break
          onEvent({ kind: 'error', message: describe(error) })
        }

        if (!this.running) break

        this.attempt++
        await sleep(delay, this.controller.signal)
      }
    } finally {
      this.running = false
      this.controller = null
      onState('stopped')
    }
  }

  stop(): void {
    this.running = false
    this.controller?.abort()
  }

  /**
   * Reads one connection to its end.
   *
   * @returns why it ended, for the caller's log.
   */
  private async readOnce(signal: AbortSignal): Promise<string> {
    const { baseUrl, codec, token, resume, onFrame, onEvent } = this.options

    const url = new URL(`${normaliseBase(baseUrl)}/audio/stream`)
    url.searchParams.set('codec', codec)
    if (resume && this.lastSeq !== null) {
      url.searchParams.set('from_seq', String(seqNext(this.lastSeq)))
    }

    const response = await fetch(url, { headers: authHeaders(token), signal })

    if (response.status === 416) {
      // The requested point has been overwritten by newer audio. The response
      // carries the range still held, so the page can say how much was missed
      // instead of just reporting a failure.
      const oldest = headerInt(response, 'X-Audio-Seq-Oldest')
      const current = headerInt(response, 'X-Audio-Seq-Current')

      let missing: number | undefined
      if (this.lastSeq !== null && oldest !== null && current !== null) {
        // Count forwards from the requested point to what is still available.
        missing = seqDistance(seqNext(this.lastSeq), oldest)
      }

      onEvent({
        kind: 'gap',
        message:
          oldest !== null && current !== null
            ? `resume point ${this.lastSeq} is gone; the server now holds ${oldest}..${current}`
            : `resume point is gone (${response.status})`,
        ...(missing !== undefined ? { missing } : {}),
      })

      // Fall back to the live edge: the alternative is no audio at all.
      this.lastSeq = null
      return 'resumed at the live edge after the resume point expired'
    }

    if (response.status === 401) {
      const detail = await errorDetail(response)
      throw new StreamError(
        `the server requires a token${detail ? `: ${detail}` : ''}`,
        response.status,
      )
    }

    if (!response.ok) {
      const detail = await errorDetail(response)
      throw new StreamError(
        `GET /audio/stream returned ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
      )
    }

    if (!response.body) {
      throw new StreamError('the response has no body to stream')
    }

    const resumed = url.searchParams.has('from_seq')
    onEvent({
      kind: 'open',
      message: resumed && this.lastSeq !== null
        ? `resumed at seq ${seqNext(this.lastSeq)}`
        : 'connected at the live edge',
    })
    this.options.onState('streaming')

    const parser = new FrameParser()
    const reader = response.body.getReader()

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return 'the server closed the stream'

        let frames: Frame[]
        try {
          frames = parser.push(value)
        } catch (error) {
          if (error instanceof ProtocolError) {
            // Framing is broken, so the rest of this connection cannot be
            // trusted. Reconnecting resynchronises from a fresh response.
            throw new StreamError(`framing error: ${error.message}`)
          }
          throw error
        }

        for (const frame of frames) {
          this.lastSeq = frame.seq
          onFrame(frame)
        }
      }
    } finally {
      // Cancelling releases the connection immediately rather than waiting for
      // the server to notice, which matters for a prompt reconnect.
      await reader.cancel().catch(() => undefined)
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

function describe(error: unknown): string {
  if (error instanceof StreamError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
