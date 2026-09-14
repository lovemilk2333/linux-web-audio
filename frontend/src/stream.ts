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
  /**
   * Where the API lives: an origin, or an origin plus a base path.
   *
   * Empty means this page's own origin, which is what happens behind a
   * reverse proxy — in development the dev server forwards /backend to the
   * API, so the page and the stream are same-origin and no CORS is involved.
   */
  baseUrl: string
  codec: string
  token: string
  /** Resume from the last sequence number seen, instead of joining live. */
  resume: boolean
  /**
   * How long the stream may go silent before it is treated as dead.
   *
   * The server sends a packet every frame period, including while the desktop
   * is silent, so a gap this long means the connection is gone rather than
   * quiet. Without it, a half-open connection is only noticed when TCP gives
   * up, which takes minutes.
   */
  stallTimeoutMs?: number
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

/**
 * The API's prefix, matching the server's --base-path.
 *
 * Relative, so it resolves against whatever origin served the page. That is
 * what makes a reverse proxy work without configuration: the dev server
 * forwards this prefix, and in a deployment a proxy serves both.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '/backend').replace(/\/+$/, '')

/** Resolves a server setting into the root every request is built from. */
export function apiRoot(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') {
    // Same origin: relative, so it also works when the page is served from a
    // subpath.
    return API_BASE
  }
  // An absolute server still carries the base path, unless it already has one.
  return trimmed.endsWith(API_BASE) ? trimmed : trimmed + API_BASE
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
  const response = await fetch(`${apiRoot(baseUrl)}/audio/info`, {
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
    const baseDelay = this.options.retryDelayMs ?? 250
    const maxDelay = 5000

    try {
      while (this.running) {
        onState(this.attempt === 0 ? 'connecting' : 'reconnecting')

        try {
          const ended = await this.readOnce(this.controller.signal)
          if (!this.running) break

          // The stream opened and then ended, so the connection worked: the
          // next attempt is a fresh drop, not a broken server, and should not
          // inherit the previous backoff.
          this.attempt = 0
          onEvent({ kind: 'closed', message: ended })
        } catch (error) {
          if (!this.running || this.controller.signal.aborted) break
          onEvent({ kind: 'error', message: describe(error) })
        }

        if (!this.running) break

        // First retry quickly — a local stream usually recovers at once — then
        // back off so a server that is genuinely down is not hammered.
        this.attempt++
        const delay = Math.min(baseDelay * 2 ** (this.attempt - 1), maxDelay)
        onEvent({ kind: 'notice', message: `reconnecting in ${Math.round(delay)} ms` })
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

    const url = new URL(`${apiRoot(baseUrl)}/audio/stream`, document.baseURI)
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

    const stallTimeout = this.options.stallTimeoutMs ?? 3000

    try {
      for (;;) {
        const { value, done } = await readOrStall(reader, stallTimeout)
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

/**
 * Reads a chunk, giving up if nothing arrives for `timeoutMs`.
 *
 * A dropped connection that closes cleanly is noticed immediately, but one
 * that goes half-open — a sleeping laptop, a dead router — leaves read()
 * pending until TCP times out. The stream is never quiet for long, so silence
 * is a reliable signal.
 */
function readOrStall(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const pending = reader.read()
  // The timeout may win the race, leaving this rejection unobserved.
  pending.catch(() => undefined)

  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StreamError(`nothing arrived for ${timeoutMs} ms, treating the stream as dead`)),
      timeoutMs,
    )
  })

  return Promise.race([pending, stalled]).finally(() => clearTimeout(timer))
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
