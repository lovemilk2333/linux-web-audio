// SPDX-License-Identifier: BSD-3-Clause

import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.WEBAUDIO_PAGE_PORT ?? 4173)

/**
 * End-to-end configuration.
 *
 * The page is served over HTTP rather than file://, because module scripts and
 * audioWorklet.addModule both need a real origin. The server under test is
 * started separately — see e2e/README.md — so these tests are not part of
 * `pnpm test`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Use the Chrome already installed on the machine rather than
        // downloading Playwright's own build.
        channel: 'chrome',
        launchOptions: {
          args: [
            // Headless Chrome refuses to start an AudioContext without a user
            // gesture, and the page connects on a click. Without this the
            // audio graph never leaves 'suspended'.
            '--autoplay-policy=no-user-gesture-required',
            // Give the page a working audio output in headless, so the
            // worklet's process() is actually called.
            '--use-fake-device-for-media-stream',
            '--mute-audio',
          ],
        },
      },
    },
  ],

  webServer: {
    // Serve the built page. `vite preview` respects the relative base, which is
    // what makes the worklet resolve correctly.
    // Pinned to IPv4. Left to itself vite preview binds [::1] only, and a
    // browser reaching 127.0.0.1 then finds nothing listening.
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
