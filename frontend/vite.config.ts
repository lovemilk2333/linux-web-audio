// SPDX-License-Identifier: BSD-3-Clause

// defineConfig comes from vitest/config rather than vite: it is the same
// function with the `test` block typed, which a plain Vite config rejects.
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Where the dev and preview servers forward /backend to. Overridable so a
// server on another port, or another machine, needs no edit here.
const API_TARGET = process.env.WEBAUDIO_API ?? 'http://127.0.0.1:8642'

/**
 * The proxy is what the frontend is normally developed against: the page and
 * the API end up on one origin, so there is no CORS preflight, no
 * Access-Control-Expose-Headers for the X-Audio-* headers, and no second
 * origin to keep in sync with --cors.
 *
 * Streaming matters here. http-proxy pipes the response through by default,
 * so a chunked stream arrives chunk by chunk rather than being buffered.
 */
const proxy = {
  '/backend': {
    target: API_TARGET,
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [vue()],
  // Relative base so the built page works from any path, including a subpath
  // on a static host, without knowing where it will be mounted.
  base: './',
  build: {
    target: 'es2022',
    // The worklet has to stay a separate, unbundled file: the browser loads it
    // with audioWorklet.addModule(url), not as part of the bundle.
    assetsInlineLimit: 0,
  },
  // Bound explicitly: the default resolves to [::1] on this system, which
  // does not match a 127.0.0.1 origin and silently fails the CORS check.
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', proxy },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
