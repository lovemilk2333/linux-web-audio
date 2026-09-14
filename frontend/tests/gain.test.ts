// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest'

import { MAX_GAIN_DB, MIN_GAIN_DB, clampGainDb, dbToLinear, formatGain, linearToDb } from '../src/audio/gain'

describe('dbToLinear', () => {
  it('leaves unity alone', () => {
    expect(dbToLinear(0)).toBe(1)
  })

  it('halves at -6 dB and doubles at +6 dB', () => {
    expect(dbToLinear(-6)).toBeCloseTo(0.5012, 4)
    expect(dbToLinear(6)).toBeCloseTo(1.9953, 4)
  })

  it('reaches exact silence at the bottom of the range', () => {
    expect(dbToLinear(MIN_GAIN_DB)).toBe(0)
    expect(dbToLinear(MIN_GAIN_DB - 10)).toBe(0)
    // Just above the bottom it is quiet but not off.
    expect(dbToLinear(MIN_GAIN_DB + 0.5)).toBeGreaterThan(0)
  })

  it('survives nonsense without going silent on the user', () => {
    // A NaN reaching the audio thread as a gain would produce NaN samples, so
    // anything unusable falls back to unity rather than to zero or NaN.
    expect(dbToLinear(Number.NaN)).toBe(1)
    expect(dbToLinear(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('linearToDb', () => {
  it('round-trips', () => {
    for (const db of [-50, -12, -6, 0, 6, 12]) {
      expect(linearToDb(dbToLinear(db))).toBeCloseTo(db, 6)
    }
  })

  it('reports silence at or below zero', () => {
    expect(linearToDb(0)).toBe(MIN_GAIN_DB)
    expect(linearToDb(-1)).toBe(MIN_GAIN_DB)
  })
})

describe('clampGainDb', () => {
  it('holds the offered range', () => {
    expect(clampGainDb(-1000)).toBe(MIN_GAIN_DB)
    expect(clampGainDb(1000)).toBe(MAX_GAIN_DB)
    expect(clampGainDb(3.5)).toBe(3.5)
    expect(clampGainDb(Number.NaN)).toBe(0)
  })
})

describe('formatGain', () => {
  it('names the ends rather than printing them as numbers', () => {
    expect(formatGain(MIN_GAIN_DB)).toBe('silent')
    expect(formatGain(0)).toBe('0 dB')
    expect(formatGain(6)).toBe('+6.0 dB')
    expect(formatGain(-6)).toBe('-6.0 dB')
  })
})
