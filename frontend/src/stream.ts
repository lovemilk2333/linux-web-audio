// SPDX-License-Identifier: BSD-3-Clause

import { FrameParser, ProtocolError, seqNext, type Frame } from './audio/protocol'

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
  /** Exponential moving average of Encode(), in microseconds. */
  encode_us?: number
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
   * Called just before a reconnect attempt, so the page can drop in-flight
   * decode timing. Without it, WebCodecs would fold the stall into decodeMs.
   */
  onReconnect?: () => void
  /**
   * The sequence number to resume after, when the caller already knows it.
   *
   * A reader that reconnects internally remembers this itself, but a caller
   * that tears the reader down and builds a new one — as the page does when
   * the connection is dropped deliberately — has to hand the point over.
   */
  resumeFrom?: number | null
  /**
   * The play-buffer target, in milliseconds. Sent as `buffer_ms` so the
   * server can prefill that much history at 2× and drop to 0.75× once the
   * lead reaches it. Omit to join at the live edge with no prefill.
   */
  bufferMs?: number
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

/** The WebSocket handshake never completed; the caller may try HTTP instead. */
class HandshakeError extends StreamError {
  constructor(message: string) {
    super(message)
    this.name = 'HandshakeError'
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

export interface StreamURLOptions {
  baseUrl: string
  codec: string
  /** Resume from this sequence number, or omit to join live. */
  fromSeq?: number | null
  /**
   * When set, put the token on `?token=` rather than in a header.
   *
   * Browsers cannot set Authorization on `WebSocket()`, so the handshake
   * carries the secret in the query. It will appear in reverse-proxy access
   * logs; that is the cost of authenticating a handshake the page cannot
   * otherwise sign.
   */
  tokenQuery?: string
  /** Play-buffer target in milliseconds; omit to join at the live edge. */
  bufferMs?: number
}

/**
 * Builds the stream URL, for either fetch or WebSocket.
 *
 * Relative `baseUrl` values resolve against `document.baseURI`, which is how
 * the page and a reverse proxy share an origin with nothing to configure.
 */
export function streamURL(options: StreamURLOptions, websocket: boolean): URL {
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/'
  const url = new URL(`${apiRoot(options.baseUrl)}/audio/stream`, base)
  url.searchParams.set('codec', options.codec)
  if (options.fromSeq != null) {
    url.searchParams.set('from_seq', String(options.fromSeq))
  }
  if (options.tokenQuery) {
    url.searchParams.set('token', options.tokenQuery)
  }
  if (options.bufferMs != null && options.bufferMs > 0) {
    url.searchParams.set('buffer_ms', String(options.bufferMs))
  }
  if (websocket) {
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  }
  return url
}

/* The HTTP long-connection (chunked GET) path used to live here as a
 * fallback when the WebSocket handshake failed. The page no longer uses
 * it: a reverse proxy is allowed to buffer a streaming HTTP response,
 * which is why the browser is WebSocket-only. `webclient` still speaks
 * that path. headerInt / readFetch / readOrStall were the reader. */

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
 * was missed rather than skipping a hole in the audio. If the handshake is
 * refused — the constructor cannot read a 416 — the next attempt joins at the
 * live edge instead of looping the same `from_seq`.
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

        // Leave streaming immediately: the socket is already gone, and
        // sitting in that state until the backoff ends would keep playing
        // (and, with loop-on-underrun, repeating) the last audio.
        onState('reconnecting')
        this.options.onReconnect?.()

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
   * The page is WebSocket-only. A long-lived HTTP response is allowed to
   * buffer through a reverse proxy, and a binary message per packet is not.
   * The HTTP chunked path is still what `webclient` speaks; it is not used
   * here. A 416 on the handshake lands as a close — the constructor cannot
   * read those headers — so a resume that the server no longer holds falls
   * back to the live edge on the same attempt.
   *
   * @returns why it ended, for the caller's log.
   */
  private async readOnce(signal: AbortSignal): Promise<string> {
    if (typeof WebSocket === 'undefined') {
      throw new StreamError('this browser has no WebSocket')
    }

    const fromSeq = this.options.resume && this.lastSeq !== null ? seqNext(this.lastSeq) : null

    try {
      return await this.readWebSocket(signal, fromSeq)
    } catch (error) {
      if (!this.running || signal.aborted) throw error
      if (!(error instanceof HandshakeError) || fromSeq === null) throw error

      // 416 (resume point gone) is indistinguishable from any other
      // handshake close. Joining live still plays; staying on a dead
      // from_seq would loop the same failure.
      this.lastSeq = null
      this.options.onEvent({
        kind: 'gap',
        message: `resume point ${fromSeq} was refused; joining at the live edge`,
      })
      return await this.readWebSocket(signal, null)
    }
  }

  private async readWebSocket(signal: AbortSignal, fromSeq: number | null): Promise<string> {
    const { baseUrl, codec, token, onFrame, onEvent, bufferMs } = this.options
    const url = streamURL({
      baseUrl,
      codec,
      fromSeq,
      tokenQuery: token || undefined,
      bufferMs,
    }, true)

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      throw new HandshakeError(error instanceof Error ? error.message : String(error))
    }
    socket.binaryType = 'arraybuffer'

    try {
      await waitForOpen(socket, signal)
    } catch (error) {
      socket.close()
      throw error
    }

    const resumed = fromSeq !== null
    onEvent({
      kind: 'open',
      message: resumed && this.lastSeq !== null
        ? `resumed at seq ${seqNext(this.lastSeq)}`
        : 'connected at the live edge',
    })
    this.options.onState('streaming')

    const parser = new FrameParser()
    const stallTimeout = this.options.stallTimeoutMs ?? 3000

    try {
      for (;;) {
        const data = await nextMessage(socket, stallTimeout, signal)
        if (data === null) return 'the server closed the stream'

        let frames
        try {
          frames = parser.push(data)
        } catch (error) {
          if (error instanceof ProtocolError) {
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
      socket.close()
    }
  }

  // The HTTP long-connection reader used to live here as `readFetch`.
  // Kept out of the page: see the note above streamURL.
}

/**
 * Resolves when the socket opens, or rejects if it closes first.
 *
 * A 416 / 401 on the handshake lands here as a close: the constructor cannot
 * read those headers. A refused resume then retries at the live edge.
 */
function waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve()
      return
    }
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      reject(new HandshakeError('the websocket closed before it opened'))
      return
    }

    const onAbort = () => {
      cleanup()
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new HandshakeError('the websocket handshake failed'))
    }
    const onClose = () => {
      cleanup()
      reject(new HandshakeError('the websocket closed before it opened'))
    }
    const cleanup = () => {
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }

    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/**
 * Waits for one binary message, or null if the socket closed cleanly.
 *
 * A stall is treated as a dead connection, the same as on the HTTP path: the
 * server sends a packet every frame period, including silence.
 */
function nextMessage(
  socket: WebSocket,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      resolve(null)
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    const onAbort = () => {
      cleanup()
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    const onMessage = (event: MessageEvent) => {
      cleanup()
      if (event.data instanceof ArrayBuffer) {
        resolve(new Uint8Array(event.data))
        return
      }
      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then(
          (buffer) => resolve(new Uint8Array(buffer)),
          reject,
        )
        return
      }
      reject(new StreamError('the websocket sent a non-binary message'))
    }
    const onError = () => {
      cleanup()
      reject(new StreamError('the websocket failed'))
    }
    const onClose = () => {
      cleanup()
      resolve(null)
    }
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }

    timer = setTimeout(() => {
      cleanup()
      reject(new StreamError(`nothing arrived for ${timeoutMs} ms, treating the stream as dead`))
    }, timeoutMs)

    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
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
