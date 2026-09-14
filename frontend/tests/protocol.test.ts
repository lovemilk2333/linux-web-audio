// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest'

import {
  Flag,
  FrameParser,
  HEADER_SIZE,
  MAGIC,
  MAX_PAYLOAD,
  ProtocolError,
  seqAhead,
  seqDiff,
  seqDistance,
  seqInWindow,
  seqNext,
  type Frame,
} from '../src/audio/protocol'

/** Builds a packet the way the server does, for the parser to take apart. */
function encode(frame: Omit<Frame, 'payload'> & { payload: number[] }): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + frame.payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC)
  view.setUint8(4, 1)
  view.setUint8(5, frame.flags)
  view.setUint16(6, frame.seq)
  view.setUint32(8, frame.timestamp)
  view.setUint32(12, frame.payload.length)
  out.set(frame.payload, HEADER_SIZE)
  return out
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

describe('FrameParser', () => {
  it('parses a single frame', () => {
    const parser = new FrameParser()
    const frames = parser.push(encode({ flags: Flag.Silence, seq: 42, timestamp: 960, payload: [1, 2, 3] }))

    expect(frames).toHaveLength(1)
    expect(frames[0]!.seq).toBe(42)
    expect(frames[0]!.timestamp).toBe(960)
    expect(frames[0]!.flags).toBe(Flag.Silence)
    expect([...frames[0]!.payload]).toEqual([1, 2, 3])
    expect(parser.buffered).toBe(0)
  })

  it('parses several frames delivered in one chunk', () => {
    const parser = new FrameParser()
    const frames = parser.push(
      concat(
        encode({ flags: 0, seq: 1, timestamp: 0, payload: [1] }),
        encode({ flags: 0, seq: 2, timestamp: 960, payload: [2, 2] }),
        encode({ flags: 0, seq: 3, timestamp: 1920, payload: [] }),
      ),
    )

    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3])
    expect(frames.map((f) => f.payload.length)).toEqual([1, 2, 0])
  })

  // The network decides where chunk boundaries fall, so every split has to
  // work — including one that lands inside the header.
  it('reassembles a frame split at every possible byte boundary', () => {
    const packet = encode({ flags: Flag.Catchup, seq: 513, timestamp: 65535, payload: [9, 8, 7, 6, 5] })

    for (let split = 1; split < packet.length; split++) {
      const parser = new FrameParser()
      const first = parser.push(packet.slice(0, split))
      const second = parser.push(packet.slice(split))

      const frames = [...first, ...second]
      expect(frames, `split at ${split}`).toHaveLength(1)
      expect(frames[0]!.seq).toBe(513)
      expect(frames[0]!.timestamp).toBe(65535)
      expect([...frames[0]!.payload]).toEqual([9, 8, 7, 6, 5])
    }
  })

  it('parses a stream delivered one byte at a time', () => {
    const parser = new FrameParser()
    const packet = encode({ flags: 0, seq: 7, timestamp: 10, payload: [4, 5, 6] })

    const frames = []
    for (const byte of packet) {
      frames.push(...parser.push(new Uint8Array([byte])))
    }

    expect(frames).toHaveLength(1)
    expect([...frames[0]!.payload]).toEqual([4, 5, 6])
  })

  it('holds a partial header without reporting anything', () => {
    const parser = new FrameParser()
    const packet = encode({ flags: 0, seq: 1, timestamp: 0, payload: [1, 2] })

    expect(parser.push(packet.slice(0, HEADER_SIZE - 1))).toEqual([])
    expect(parser.buffered).toBe(HEADER_SIZE - 1)

    const frames = parser.push(packet.slice(HEADER_SIZE - 1))
    expect(frames).toHaveLength(1)
  })

  it('rejects a bad magic', () => {
    const parser = new FrameParser()
    const packet = encode({ flags: 0, seq: 1, timestamp: 0, payload: [] })
    packet[0] = 0x58 // "X"

    expect(() => parser.push(packet)).toThrow(ProtocolError)
  })

  it('rejects an unsupported version', () => {
    const parser = new FrameParser()
    const packet = encode({ flags: 0, seq: 1, timestamp: 0, payload: [] })
    packet[4] = 2

    expect(() => parser.push(packet)).toThrow(/unsupported protocol version/)
  })

  // A corrupt length must not make the page allocate without bound.
  it('rejects an absurd payload length', () => {
    const parser = new FrameParser()
    const packet = encode({ flags: 0, seq: 1, timestamp: 0, payload: [] })
    new DataView(packet.buffer).setUint32(12, MAX_PAYLOAD + 1)

    expect(() => parser.push(packet)).toThrow(/exceeds/)
  })

  // The parser buffers a partial frame between calls, so it has to copy what
  // it keeps. Holding a view would let a caller reuse its chunk buffer, which
  // a streaming reader naturally does, quietly corrupting the header.
  it('copies the bytes it buffers, so mutating the caller’s chunk is safe', () => {
    const parser = new FrameParser()
    const packet = encode({ flags: 0, seq: 1, timestamp: 0, payload: [1, 2, 3] })

    const head = packet.slice(0, 6)
    parser.push(head)
    head.fill(0xff)

    const frames = parser.push(packet.slice(6))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.seq).toBe(1)
    expect([...frames[0]!.payload]).toEqual([1, 2, 3])
  })
})

describe('sequence arithmetic', () => {
  it('measures distance across the wrap', () => {
    expect(seqDistance(65535, 0)).toBe(1)
    expect(seqDistance(65534, 1)).toBe(3)
    expect(seqDistance(0, 0)).toBe(0)
  })

  it('reports a signed difference', () => {
    expect(seqDiff(65535, 0)).toBe(1)
    expect(seqDiff(0, 65535)).toBe(-1)
    expect(seqDiff(1, 1)).toBe(0)
  })

  it('compares across the wrap', () => {
    expect(seqAhead(0, 65535)).toBe(true)
    expect(seqAhead(65535, 0)).toBe(false)
    expect(seqAhead(1, 1)).toBe(false)
    // Half the space away is ambiguous, and reads as behind.
    expect(seqAhead(0x8000, 0)).toBe(false)
  })

  it('checks a window that spans the wrap', () => {
    expect(seqInWindow(5, 65500, 10)).toBe(true)
    expect(seqInWindow(65500, 65500, 10)).toBe(true)
    expect(seqInWindow(10, 65500, 10)).toBe(true)
    expect(seqInWindow(65499, 65500, 10)).toBe(false)
    expect(seqInWindow(11, 65500, 10)).toBe(false)
  })

  it('advances and wraps', () => {
    expect(seqNext(0)).toBe(1)
    expect(seqNext(65535)).toBe(0)
  })
})

describe('flagNames', () => {
  it('names the bits that are set', async () => {
    const { flagNames } = await import('../src/audio/protocol')
    expect(flagNames(0)).toEqual([])
    expect(flagNames(Flag.Discontinuity | Flag.Catchup)).toEqual(['discontinuity', 'catchup'])
    expect(flagNames(Flag.Silence | Flag.Underrun)).toEqual(['silence', 'underrun'])
  })
})
