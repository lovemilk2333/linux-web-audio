<!-- SPDX-License-Identifier: BSD-3-Clause -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'

import ConnectionPanel from './components/ConnectionPanel.vue'
import EventLog, { type LogEntry } from './components/EventLog.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import StatsPanel from './components/StatsPanel.vue'

import { chooseCodec, createDecoder, opusPath, type Decoder, type StreamFormat } from './audio/decoder'
import { Player, type PlayerStatus } from './audio/player'
import { StreamStats } from './stats'
import { fetchInfo, StreamReader, type ServerInfo, type StreamState } from './stream'

/** Settings that survive a reload. */
const STORAGE_KEY = 'linux-web-audio:settings'

interface Settings {
  baseUrl: string
  token: string
  codec: string
  targetMs: number
  resume: boolean
  theme: 'system' | 'light' | 'dark'
}

function loadSettings(): Settings {
  const defaults: Settings = {
    baseUrl: `${location.protocol}//${location.hostname}:8642`,
    token: '',
    codec: '',
    targetMs: 300,
    resume: true,
    theme: 'system',
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    // Merged over the defaults so a settings object written by an older
    // version does not leave a field undefined.
    return { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return defaults
  }
}

const settings = reactive<Settings>(loadSettings())

const state = ref<StreamState>('idle')
const info = shallowRef<ServerInfo | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)
const entries = ref<LogEntry[]>([])
const playableCodecs = ref<string[]>([])
/** How Opus will be decoded here, once the server's format is known. */
const opusDecodePath = ref<'webcodecs' | 'wasm' | 'none'>('none')
/** Bumped on a timer so the stats panel re-renders; its data mutates in place. */
const tick = ref(0)

const playerStatus = reactive<PlayerStatus>({
  bufferedMs: 0,
  underruns: 0,
  droppedFrames: 0,
  peak: 0,
  silent: true,
  playing: false,
  playedMs: 0,
  targetMs: 0,
})

/* Bound once for the template. Deliberately not named `location`: that would
 * shadow window.location for the whole module, including loadSettings. */
const pageLocation = {
  origin: window.location.origin,
  hostname: window.location.hostname,
  port: window.location.port,
}

const player = new Player()
const stats = shallowRef(new StreamStats(960))
let reader: StreamReader | null = null
let decoder: Decoder | null = null
let logId = 0

const connected = computed(() => state.value === 'streaming' || state.value === 'reconnecting')

/* Both AudioWorklet and WebCodecs are secure-context-only. Rather than let the
 * user find that out as a TypeError when they press connect, say so on arrival
 * and give the ways out. */
const insecureContext = computed(() => !window.isSecureContext)
const insecureRemedy = computed(() => {
  const port = pageLocation.port || '4173'
  return [
    'Serve the page over https:// — a self-signed certificate is enough.',
    `Open it as http://localhost:${port} instead of http://${pageLocation.hostname}:${port}. ` +
      `From a phone, "adb reverse tcp:${port} tcp:${port}" makes the phone's own localhost reach this server, and localhost counts as secure.`,
    `For a temporary exception, Chrome accepts --unsafely-treat-insecure-origin-as-secure=${pageLocation.origin}`,
  ]
})

/* The buffer is measured in frames, because that is the unit audio arrives in.
 *
 * Deliberately not rounded. Opus allows a 2.5 ms frame, and rounding the step
 * to whole milliseconds would put the floor at 6 ms for a stream whose frames
 * are 2.5 ms, when 5 ms is exactly two of them. */
const targetStepMs = computed(() => {
  const ms = info.value?.frame_duration_ms ?? 20
  return ms > 0 ? ms : 20
})

/** Frames per Web Audio render block; process() is always handed this many. */
const RENDER_QUANTUM = 128

/* The floor is two frames, or four render blocks, whichever is longer.
 *
 * Two frames is the logical minimum: one is a buffer that starts already
 * empty. But that is not always enough in practice, because the audio thread
 * is handed whole blocks and has to fill each one from the queue. A 2.5 ms
 * frame is 120 samples, smaller than a 128-sample block, so two of them is
 * 1.9 blocks — not enough to cover a block plus the wait for the next packet.
 *
 * Measured at 2.5 ms frames: a 5 ms buffer dropped out 476 times in three
 * seconds. Four blocks was clean but marginal, still losing a packet every
 * second or two under load, because the floor also has to absorb main-thread
 * jitter — every packet is decoded there before it is posted to this thread.
 * Six blocks is comfortable at the floor and still cheap: ~16 ms. */
const minTargetMs = computed(() => {
  const step = targetStepMs.value
  const sampleRate = info.value?.sample_rate || 48000
  const blockMs = ((6 * RENDER_QUANTUM) / sampleRate) * 1000
  const floorMs = Math.max(step * 2, blockMs)
  // Landed on a whole number of frames, since that is what the buffer holds.
  return Math.ceil(floorMs / step) * step
})

function log(kind: LogEntry['kind'], message: string, missing?: number): void {
  const now = new Date()
  const at = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(
    now.getSeconds(),
  ).padStart(2, '0')}`
  entries.value = [{ id: ++logId, at, kind, message, ...(missing ? { missing } : {}) }, ...entries.value].slice(0, 200)
}

/* Settings are persisted, but through a debounce: the buffer slider fires on
   every pixel of movement, and writing on each one is pointless work. */
let saveTimer: number | undefined
watch(
  settings,
  () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
      } catch {
        // Storage can be full or blocked; the page still works without it.
      }
    }, 250)
  },
  { deep: true },
)

watch(
  () => settings.targetMs,
  (ms) => player.setTargetMs(ms),
)

watch(
  () => settings.theme,
  (theme) => {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme')
    } else {
      document.documentElement.setAttribute('data-theme', theme)
    }
  },
  { immediate: true },
)

onMounted(async () => {
  const stop = player.onStatus((status) => Object.assign(playerStatus, status))
  onBeforeUnmount(stop)

  /* The live state, for the console and for the end-to-end tests. Scraping the
   * rendered text would test the formatter as much as the stream, and would
   * depend on how the panels happen to be laid out. */
  Object.defineProperty(window, '__webaudio', {
    configurable: true,
    value: {
      get state() {
        return state.value
      },
      get info() {
        return info.value
      },
      get stats() {
        return stats.value
      },
      get player() {
        return { ...playerStatus }
      },
      get events() {
        return entries.value
      },
      get error() {
        return error.value
      },
    },
  })

  const ticker = window.setInterval(() => {
    tick.value++
  }, 200)
  onBeforeUnmount(() => window.clearInterval(ticker))

  // Probe the server so the codec list is populated before the user presses
  // connect; a failure here is normal and simply leaves the field blank.
  try {
    await refreshInfo()
  } catch {
    // Reported when the user actually tries to connect.
  }

  // Browsers suspend audio when a tab is hidden. Resuming on return costs
  // nothing and avoids a silent page that looks connected.
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') void player.resume()
  }
  document.addEventListener('visibilitychange', onVisibility)
  onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisibility))
})

onBeforeUnmount(() => {
  reader?.stop()
  decoder?.close()
  void player.stop()
})

async function refreshInfo(): Promise<ServerInfo> {
  const fetched = await fetchInfo(settings.baseUrl, settings.token)
  info.value = fetched

  // A stored setting can fall outside what this server's frame size allows: a
  // longer frame duration moves the floor up, and any duration can move the
  // step, so a value from a previous session may no longer land on one.
  const step = fetched.frame_duration_ms > 0 ? fetched.frame_duration_ms : 20
  const blockMs = ((6 * RENDER_QUANTUM) / (fetched.sample_rate || 48000)) * 1000
  const floor = Math.ceil(Math.max(step * 2, blockMs) / step) * step
  const snapped = Math.round(settings.targetMs / step) * step
  settings.targetMs = Math.max(snapped, floor)

  const format: StreamFormat = { sampleRate: fetched.sample_rate, channels: fetched.channels }

  // Opus is playable either way — natively where WebCodecs exists, otherwise
  // through the WASM decoder — so everything the server offers is playable.
  const playable: string[] = []
  if (fetched.codecs.includes('opus')) {
    playable.push('opus')
    opusDecodePath.value = await opusPath(format)
  }
  for (const name of ['pcm_s16le', 'pcm_f32le']) {
    if (fetched.codecs.includes(name)) playable.push(name)
  }
  playableCodecs.value = playable
  return fetched
}

async function connect({ reconnecting = false } = {}): Promise<void> {
  if (connected.value || busy.value) return

  busy.value = true
  error.value = null

  // Read before anything is replaced: on a reconnect this is what lets the
  // server replay the audio produced while the connection was down.
  const resumeFrom = reconnecting ? stats.value.lastSeq : null

  try {
    const fetched = await refreshInfo()

    if (!fetched.started) {
      throw new Error('the server has not captured any audio yet')
    }

    const format: StreamFormat = { sampleRate: fetched.sample_rate, channels: fetched.channels }
    const chosen = await chooseCodec(
      fetched.codecs,
      format,
      settings.codec && playableCodecs.value.includes(settings.codec) ? settings.codec : undefined,
    )
    settings.codec = chosen.codec
    log('notice', `using ${chosen.codec} — ${chosen.reason}`)

    // Starting audio requires a user gesture, and this runs from the connect
    // click, so it is the right moment to build the audio graph — but only
    // once. Rebuilding it on every reconnect would tear down the buffer and
    // reintroduce the startup gap for no reason.
    if (!player.running) {
      const rate = await player.start(format, settings.targetMs)
      if (rate !== format.sampleRate) {
        log(
          'error',
          `the browser gave a ${rate} Hz audio context for a ${format.sampleRate} Hz stream, so playback will be pitched`,
        )
      }
    }

    if (!reconnecting) {
      stats.value = new StreamStats(fetched.frame_samples)
      stats.value.sampleRate = fetched.sample_rate
      stats.value.start()
      player.reset()
    }

    decoder?.close()
    const sink = (channels: Float32Array[]) => player.push(channels)
    const onDecodeError = (decodeError: Error) => log('error', `decode failed: ${decodeError.message}`)

    let activeCodec = chosen.codec
    try {
      decoder = await createDecoder(activeCodec, format, sink, onDecodeError)
    } catch (cause) {
      // Most likely the WASM decoder could not be fetched. Falling back to raw
      // PCM keeps audio playing at a cost in bandwidth, which beats silence.
      const fallback = fetched.codecs.find((name) => name.startsWith('pcm_'))
      if (activeCodec !== 'opus' || !fallback) throw cause

      log('error', `Opus decoding is unavailable: ${describeError(cause)}`)
      activeCodec = fallback
      decoder = await createDecoder(activeCodec, format, sink, onDecodeError)
      log('notice', `falling back to ${activeCodec}, about sixteen times the bandwidth`)
    }
    if (activeCodec !== chosen.codec) {
      settings.codec = activeCodec
    }

    reader = new StreamReader({
      baseUrl: settings.baseUrl,
      codec: activeCodec,
      token: settings.token,
      resume: settings.resume,
      resumeFrom,
      onFrame: (frame) => {
        stats.value.observe(frame)
        decoder?.decode(frame)
      },
      onEvent: (event) => {
        log(event.kind, event.message, event.missing)
        if (event.kind === 'error') error.value = event.message
        if (event.kind === 'open') error.value = null
      },
      onState: (next) => {
        state.value = next
      },
    })

    state.value = 'connecting'
    void reader.start()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    state.value = 'failed'
    log('error', error.value)
  } finally {
    busy.value = false
  }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function disconnect(): void {
  reader?.stop()
  reader = null
  decoder?.close()
  decoder = null
  stats.value.stop()
  void player.stop()
  state.value = 'stopped'
  log('closed', 'disconnected')
}

/**
 * Cuts the connection and reconnects after a moment, to exercise the resume
 * path the way a real network drop would.
 *
 * The pause matters: it gives the server time to produce audio nobody is
 * receiving, so the replay has something to hand back.
 */
function dropConnection(): void {
  log('notice', 'dropping the connection to exercise the resume path')
  reader?.stop()
  reader = null
  decoder?.close()
  decoder = null
  state.value = 'stopped'

  globalThis.setTimeout(() => {
    void connect({ reconnecting: true })
  }, 1500)
}
</script>

<template>
  <div class="app">
    <header>
      <h1>linux-web-audio</h1>
      <p class="sub">
        Desktop audio over an HTTP long connection. The page decodes it with WebCodecs where it can
        and plays it through an AudioWorklet.
      </p>
    </header>

    <div v-if="insecureContext" class="banner bad">
      <strong>This page is not a secure context, so audio cannot play here.</strong>
      <p>
        Browsers only expose the AudioWorklet and WebCodecs APIs over <code>https://</code> or on
        <code>localhost</code>. Loading the page from <code>{{ pageLocation.origin }}</code> strips both,
        so there is nothing to decode into and nothing to play through.
      </p>
      <ul>
        <li v-for="(remedy, index) in insecureRemedy" :key="index">{{ remedy }}</li>
      </ul>
    </div>

    <div class="columns">
      <div class="column">
        <ConnectionPanel
          v-model:base-url="settings.baseUrl"
          v-model:token="settings.token"
          v-model:codec="settings.codec"
          :state="state"
          :info="info"
          :player="playerStatus"
          :error="error"
          :busy="busy"
          :playable-codecs="playableCodecs"
          @connect="connect"
          @disconnect="disconnect"
        />
        <SettingsPanel
          v-model:target-ms="settings.targetMs"
          :min-target-ms="minTargetMs"
          :target-step-ms="targetStepMs"
          v-model:resume="settings.resume"
          v-model:theme="settings.theme"
          :repeatable="connected"
          @disconnect-now="dropConnection"
        />
      </div>

      <div class="column">
        <StatsPanel :stats="stats" :player="playerStatus" :connected="connected" :tick="tick" />
        <EventLog :entries="entries" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  max-width: 1100px;
  margin: 0 auto;
}

header {
  margin-bottom: 1.25rem;
}

.sub {
  margin: 0.3rem 0 0;
  color: var(--muted);
  font-size: 0.88rem;
  max-width: 60ch;
}

.banner {
  border: 1px solid var(--panel-edge);
  border-radius: 10px;
  padding: 0.9rem 1.1rem;
  margin-bottom: 1rem;
  font-size: 0.86rem;
}

.banner.bad {
  border-color: var(--hot);
  background: color-mix(in srgb, var(--hot) 8%, var(--panel));
}

.banner p {
  margin: 0.5rem 0 0;
  color: var(--muted);
}

.banner ul {
  margin: 0.6rem 0 0;
  padding-left: 1.2rem;
  color: var(--muted);
}

.banner li {
  margin-bottom: 0.25rem;
}

.columns {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 1rem;
  align-items: start;
}

.column {
  display: grid;
  gap: 1rem;
  min-width: 0;
}

/* One column on a narrow screen rather than a squeezed two. */
@media (max-width: 880px) {
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
