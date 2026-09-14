# End-to-end tests

Browser tests against a real server and a real audio session. They are kept out
of `pnpm test` because they need both.

## Running

```sh
# 1. a server, on its defaults
webaudiod -log-level info

# 2. the built page, and the tests
cd frontend
pnpm build
pnpm e2e
```

No `--cors`: the preview server proxies `/backend` to the API, so the page and
the stream share an origin. The page's Server field is left blank, which means
"current origin".

Set `WEBAUDIO_SERVER=http://host:port` to run them against a server directly
instead — that path does need `--cors`.

Playwright starts `vite preview` itself; only the API has to be running.

Chrome is used from the system (`channel: 'chrome'`) rather than downloaded,
because it is already installed and the download is a few hundred megabytes.

## What these cover that unit tests cannot

- The page talks to the real server: `/audio/info` populates the codec list
  before anything is clicked.
- WebCodecs decodes what the server actually sends, rather than what a test
  fixture claims it sends.
- The AudioWorklet receives those samples on the audio thread and plays them.
  `playedMs` is the worklet's own count of frames it has output, so it cannot
  be satisfied by the page merely deciding it played something.
- The resume path: the connection is dropped deliberately, the page reconnects
  and asks for the packet after the last one it saw, and the run passes only if
  the replay happened *and* no sequence gap appeared across the reconnect.

Assertions read the page's live state through `window.__webaudio` rather than
scraped DOM text, so changing a label or a number format cannot make a test
pass that should not.

## Headless audio

Headless Chrome needs two flags, both set in `playwright.config.ts`:

- `--autoplay-policy=no-user-gesture-required` — the page connects on a click,
  but the AudioContext is created from an async continuation, which Chrome does
  not always treat as a gesture. Without this the context stays `suspended` and
  nothing is ever played.
- `--use-fake-device-for-media-stream` — gives the page an output device so the
  worklet's `process()` is called at all.

`--mute-audio` keeps the run silent on a machine somebody is using.

## Reading the page state

```js
await page.evaluate(() => window.__webaudio.stats.summary())
```

`state`, `info`, `stats`, `player`, `events` and `error` are all live getters.

## Caveats

These need a working audio session on the machine running them, because the
server captures from it. They are not CI-friendly without one.
