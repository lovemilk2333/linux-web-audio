// SPDX-License-Identifier: BSD-3-Clause

/**
 * Playback gain, expressed to the user in decibels.
 *
 * Decibels rather than a percentage because loudness is logarithmic: a linear
 * slider spends most of its travel in a range that all sounds about the same,
 * and then falls off a cliff near the bottom.
 */

/** Quietest setting offered, which is also treated as silence. */
export const MIN_GAIN_DB = -60

/**
 * Loudest setting offered.
 *
 * Positive gain amplifies whatever noise the capture already carries, and past
 * a few dB it clips anything mastered loudly. 20 dB is enough to rescue a very
 * quiet stream without making the control a trap.
 */
export const MAX_GAIN_DB = 20

/**
 * Converts decibels to the linear multiplier the audio thread applies.
 *
 * The bottom of the range is exact silence rather than -60 dB: at -60 dB the
 * output is a thousandth of full scale, which is inaudible in a quiet room but
 * not actually off, and a control that cannot be turned off is annoying.
 */
export function dbToLinear(db: number): number {
  if (!Number.isFinite(db)) return 1
  if (db <= MIN_GAIN_DB) return 0
  return 10 ** (db / 20)
}

/** Converts a linear multiplier back to decibels, for display. */
export function linearToDb(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 0) return MIN_GAIN_DB
  return 20 * Math.log10(linear)
}

/** Keeps a value inside the range the UI offers. */
export function clampGainDb(db: number): number {
  if (!Number.isFinite(db)) return 0
  return Math.min(MAX_GAIN_DB, Math.max(MIN_GAIN_DB, db))
}

/** Renders a setting for the readout. */
export function formatGain(db: number): string {
  if (db <= MIN_GAIN_DB) return 'silent'
  if (Math.abs(db) < 0.05) return '0 dB'
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
}
