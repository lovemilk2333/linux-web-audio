import { chromium } from '@playwright/test'

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
})
const page = await browser.newPage()
await page.goto('http://127.0.0.1:4174/')
await page.evaluate(() => localStorage.clear())
await page.reload()
await page.fill('#url', 'http://127.0.0.1:8666')
await page.click('button:has-text("Connect")')
await page.waitForFunction(() => window.__webaudio?.state === 'streaming', null, { timeout: 20000 })

const probe = () => page.evaluate(() => {
  const p = { ...window.__webaudio.player }
  return { underruns: p.underruns, bufferedMs: p.bufferedMs, playing: p.playing }
})

console.log('  target   dropouts/3s   buffered   playing')
for (const ms of [5, 10, 15, 20, 30, 50, 100]) {
  await page.evaluate((t) => {
    const el = document.querySelector('#target')
    el.value = String(t)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, ms)

  await page.waitForTimeout(1000)          // let it settle after the change
  const before = await probe()
  await page.waitForTimeout(3000)          // then measure a clean window
  const after = await probe()

  const dropouts = after.underruns - before.underruns
  console.log(
    `  ${String(ms).padStart(5)} ms   ${String(dropouts).padStart(8)}   ` +
    `${after.bufferedMs.toFixed(0).padStart(6)} ms   ${after.playing}`,
  )
}
await browser.close()
