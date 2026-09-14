// SPDX-License-Identifier: BSD-3-Clause

import { expect, test, type Page } from '@playwright/test'

/**
 * End-to-end checks against a live server.
 *
 * These need webaudiod running and a live audio session. See e2e/README.md.
 * They are excluded from `pnpm test` for that reason.
 *
 * What they cover is the part unit tests cannot reach: that the page talks to
 * the real server, that WebCodecs decodes what the server actually sends, and
 * that the worklet receiving those samples on the audio thread really plays
 * them. The numbers come from the page's own state rather than from scraped
 * text, so a formatting change cannot make a passing test meaningless.
 */

/**
 * Blank: the page's own origin.
 *
 * Playwright's webServer runs `vite preview`, which forwards /backend to the
 * API, so the page and the stream share an origin and the API needs no --cors
 * for these tests. Set WEBAUDIO_SERVER to point them at a server directly.
 */
const SERVER = process.env.WEBAUDIO_SERVER ?? ''

/** The shape of window.__webaudio, as App.vue exposes it. */
interface PageState {
  state: string
  info: { codec: string; sample_rate: number; channels: number; codecs: string[] } | null
  stats: {
    packets: number
    gaps: number
    missing: number
    duplicates: number
    clockJumps: number
    catchup: number
    lastSeq: number | null
    summary: () => { ratio: number; packetsPerSecond: number }
  }
  player: { playing: boolean; underruns: number; bufferedMs: number; playedMs: number }
  events: { kind: string; message: string; missing?: number }[]
  error: string | null
  /** The buffer target in force, in milliseconds. */
  targetMs: number
}

declare global {
  interface Window {
    __webaudio: PageState
  }
}

const state = (page: Page) => page.evaluate(() => window.__webaudio as unknown as PageState)

async function connect(page: Page): Promise<void> {
  await page.fill('#url', SERVER)
  await page.click('button:has-text("Connect")')
  await expect
    .poll(async () => (await state(page)).state, { timeout: 20_000 })
    .toMatch(/streaming|reconnecting/)
}

/** Waits until the page has actually played some audio. */
async function waitForPlayback(page: Page, seconds = 2): Promise<void> {
  await expect
    .poll(async () => (await state(page)).player.playedMs, {
      timeout: 30_000,
      message: 'no audio was played',
    })
    .toBeGreaterThan(seconds * 1000)
}

test.describe('playback', () => {
  test('loads and reads the server capabilities', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('h1')).toHaveText('linux-web-audio')
    // The codec list comes from /audio/info, so populating it proves the page
    // reached the server before anything was clicked.
    await expect(page.locator('#codec option')).not.toHaveCount(0)
    await expect(page.locator('#codec option').first()).toContainText('opus')

    // The favicon is the only other request the page makes; a missing one
    // shows up in the console as a 404 and is worth failing on.
    const info = (await state(page)).info
    expect(info?.sample_rate).toBeGreaterThan(0)
  })

  test('streams, decodes and plays', async ({ page }) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
    })

    await page.goto('/')
    await connect(page)
    await waitForPlayback(page, 2)

    const current = await state(page)

    // Framing held: every packet arrived, in order, with an exact media clock.
    expect(current.stats.packets, 'packets received').toBeGreaterThan(100)
    expect(current.stats.gaps, 'sequence gaps').toBe(0)
    expect(current.stats.missing, 'missing packets').toBe(0)
    expect(current.stats.clockJumps, 'timestamp steps that were not one frame').toBe(0)

    // Opus, decoded by the browser rather than passed through.
    expect(current.info?.codec).toBe('opus')

    // The audio thread is genuinely consuming what the page decoded.
    expect(current.player.playing, 'playback started').toBe(true)
    expect(current.player.playedMs, 'audio played').toBeGreaterThan(1500)

    expect(current.error, 'reported error').toBeNull()
    expect(failures, `page failures: ${failures.join('; ')}`).toHaveLength(0)
  })

  // A real-time source cannot outrun playback, so the buffer level is a direct
  // read on whether the page is keeping up.
  test('settles at its buffer target without dropping out', async ({ page }) => {
    await page.goto('/')
    await connect(page)
    await waitForPlayback(page, 2)

    const target = await page.evaluate(() => window.__webaudio.targetMs)
    // A fresh visit follows the minimum for the stream, which is well under a
    // tenth of a second. Asserting a fixed threshold would test the default
    // rather than the behaviour.
    expect(target, 'a target is in force').toBeGreaterThan(0)

    await expect
      .poll(async () => (await state(page)).player.bufferedMs, {
        timeout: 20_000,
        message: `the buffer never approached its ${target} ms target`,
      })
      .toBeGreaterThan(target * 0.5)

    const current = await state(page)
    expect(current.player.underruns, 'playback dropouts').toBeLessThanOrEqual(1)
    expect(current.player.bufferedMs, 'buffer level').toBeLessThan(target * 4 + 500)
  })

  test('resumes after a dropped connection, with no gap', async ({ page }) => {
    await page.goto('/')
    await connect(page)
    await waitForPlayback(page, 2)

    const before = await state(page)
    expect(before.stats.packets).toBeGreaterThan(50)

    await page.click('button:has-text("Drop connection")')

    // The page reconnects on its own and asks the server to replay what was
    // missed, so the replayed packets show up in the counters.
    await expect
      .poll(async () => (await state(page)).stats.catchup, {
        timeout: 30_000,
        message: 'the server replayed nothing after the reconnect',
      })
      .toBeGreaterThan(0)

    // Audio picked back up on the same buffer, without a fresh startup gap.
    const before2 = (await state(page)).player.playedMs
    await expect
      .poll(async () => (await state(page)).player.playedMs, { timeout: 20_000 })
      .toBeGreaterThan(before2 + 1000)

    const after = await state(page)

    // The whole point: no audio was lost across the reconnect.
    expect(after.stats.gaps, 'sequence gaps across the reconnect').toBe(0)
    expect(after.stats.missing, 'packets lost across the reconnect').toBe(0)
    expect(after.stats.clockJumps, 'media clock steps off').toBe(0)

    const resumed = after.events.find((event) => event.message.startsWith('resumed at seq'))
    expect(resumed, `no resume event: ${after.events.map((e) => e.message).join(' | ')}`).toBeTruthy()
  })
})
