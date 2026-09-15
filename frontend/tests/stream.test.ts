// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest'

import { streamURL } from '../src/stream'

describe('streamURL', () => {
  it('builds a same-origin HTTP stream from an empty server', () => {
    const url = streamURL({ baseUrl: '', codec: 'opus' }, false)

    expect(url.pathname).toBe('/backend/audio/stream')
    expect(url.searchParams.get('codec')).toBe('opus')
    expect(url.searchParams.has('from_seq')).toBe(false)
    expect(url.searchParams.has('token')).toBe(false)
    expect(url.protocol).toBe('http:')
  })

  it('flips the scheme for a websocket, including https → wss', () => {
    const ws = streamURL({ baseUrl: 'http://127.0.0.1:8642', codec: 'opus' }, true)
    expect(ws.protocol).toBe('ws:')
    expect(ws.host).toBe('127.0.0.1:8642')
    expect(ws.pathname).toBe('/backend/audio/stream')

    const wss = streamURL({ baseUrl: 'https://media.example', codec: 'opus' }, true)
    expect(wss.protocol).toBe('wss:')
  })

  it('puts the resume point and the websocket token on the query', () => {
    const url = streamURL(
      { baseUrl: '', codec: 'pcm_s16le', fromSeq: 1310, tokenQuery: 'secret' },
      true,
    )

    expect(url.searchParams.get('codec')).toBe('pcm_s16le')
    expect(url.searchParams.get('from_seq')).toBe('1310')
    expect(url.searchParams.get('token')).toBe('secret')
    expect(url.protocol).toBe('ws:')
  })

  it('leaves the token off the HTTP URL, because fetch can set Authorization', () => {
    const url = streamURL({ baseUrl: '', codec: 'opus', tokenQuery: undefined }, false)
    expect(url.searchParams.has('token')).toBe(false)
  })

  it('puts a positive buffer target on the query and omits a missing one', () => {
    const withBuffer = streamURL({ baseUrl: '', codec: 'opus', bufferMs: 20 }, true)
    expect(withBuffer.searchParams.get('buffer_ms')).toBe('20')

    const without = streamURL({ baseUrl: '', codec: 'opus' }, true)
    expect(without.searchParams.has('buffer_ms')).toBe(false)

    const zero = streamURL({ baseUrl: '', codec: 'opus', bufferMs: 0 }, false)
    expect(zero.searchParams.has('buffer_ms')).toBe(false)
  })
})
