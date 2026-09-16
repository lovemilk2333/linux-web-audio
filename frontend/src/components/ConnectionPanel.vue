<!-- SPDX-License-Identifier: BSD-3-Clause -->
<script setup lang="ts">
import { computed } from 'vue'

import LevelMeter from './LevelMeter.vue'
import type { ServerInfo, StreamState } from '../stream'
import type { PlayerStatus } from '../audio/player'

const props = defineProps<{
  baseUrl: string
  token: string
  codec: string
  state: StreamState
  info: ServerInfo | null
  player: PlayerStatus
  error: string | null
  busy: boolean
  /** Codecs the browser can actually play, in preference order. */
  playableCodecs: string[]
}>()

const emit = defineEmits<{
  'update:baseUrl': [string]
  'update:token': [string]
  'update:codec': [string]
  connect: []
  disconnect: []
}>()

const connected = computed(() => props.state === 'streaming' || props.state === 'reconnecting')

const stateLabel = computed(() => {
  switch (props.state) {
    case 'idle':
      return 'not connected'
    case 'connecting':
      return 'connecting…'
    case 'streaming':
      return 'streaming'
    case 'reconnecting':
      return 'reconnecting…'
    case 'stopped':
      return 'stopped'
    case 'failed':
      return 'failed'
  }
})

const stateTone = computed(() => {
  switch (props.state) {
    case 'streaming':
      return 'ok'
    case 'connecting':
    case 'reconnecting':
      return 'warn'
    case 'failed':
      return 'bad'
    default:
      return 'idle'
  }
})

const codecOptions = computed(() => {
  const offered = props.info?.codecs ?? []
  return offered.map((name) => ({
    name,
    playable: props.playableCodecs.includes(name),
  }))
})

const warning = computed(() => {
  if (!props.info) return null
  if (props.info.codecs.length > 0 && props.playableCodecs.length === 0) {
    return 'This browser cannot play any codec the server offers.'
  }
  if (props.codec && !props.playableCodecs.includes(props.codec)) {
    return `${props.codec} cannot be decoded here; pick another codec.`
  }
  return null
})
</script>

<template>
  <div class="panel">
    <div class="head">
      <h2>Connection</h2>
      <span class="state" :class="stateTone">
        <span class="dot" />
        {{ stateLabel }}
      </span>
    </div>

    <div class="fields">
      <div class="field grow">
        <label for="url">Server <span class="optional">blank uses current origin</span></label>
        <input
          id="url"
          :value="baseUrl"
          :disabled="connected"
          spellcheck="false"
          placeholder="current origin"
          @input="emit('update:baseUrl', ($event.target as HTMLInputElement).value)"
        />
      </div>

      <div class="field codec">
        <label for="codec">Codec</label>
        <select
          id="codec"
          :value="codec"
          :disabled="connected || codecOptions.length === 0"
          @change="emit('update:codec', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="option in codecOptions" :key="option.name" :value="option.name">
            {{ option.name }}{{ option.playable ? '' : ' (unsupported here)' }}
          </option>
        </select>
      </div>

      <div class="field token">
        <label for="token">Token</label>
        <input
          id="token"
          type="password"
          :value="token"
          :disabled="connected"
          spellcheck="false"
          placeholder="optional"
          @input="emit('update:token', ($event.target as HTMLInputElement).value)"
        />
      </div>

      <div class="actions">
        <button v-if="!connected" class="primary" :disabled="busy" @click="emit('connect')">
          Connect
        </button>
        <button v-else @click="emit('disconnect')">Disconnect</button>
      </div>
    </div>

    <p v-if="warning" class="warn">{{ warning }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="info" class="meta">
      <span
        >capturing <code>{{ info.monitor || info.sink || 'unknown' }}</code></span
      >
      <span v-if="info.version" class="sep">·</span>
      <span v-if="info.version">server {{ info.version }}</span>
      <span v-if="info.capture_library" class="sep">·</span>
      <span v-if="info.capture_library">capture {{ info.capture_library }}</span>
    </div>

    <div class="meter-row">
      <LevelMeter :peak="player.peak" :clipped="player.clipped" :active="connected" />
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.9rem;
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: var(--muted);
}

.state .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--faint);
}

.state.ok .dot {
  background: var(--ok);
}
.state.warn .dot {
  background: var(--warm);
}
.state.bad .dot {
  background: var(--hot);
}

.state.ok {
  color: var(--ok);
}

.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-end;
}

.field {
  flex: 0 0 auto;
}

.field.grow {
  flex: 1 1 16rem;
}

.optional {
  color: var(--faint);
  font-weight: 400;
}

.field.codec {
  flex: 0 1 12rem;
}

.field.token {
  flex: 0 1 10rem;
}

.actions {
  margin-left: auto;
}

.warn {
  margin: 0.8rem 0 0;
  font-size: 0.82rem;
  color: var(--warn);
}

.error {
  margin: 0.8rem 0 0;
  font-size: 0.82rem;
  color: var(--danger);
}

.meta {
  margin-top: 0.9rem;
  font-size: 0.78rem;
  color: var(--muted);
}

.sep {
  margin: 0 0.4rem;
  color: var(--faint);
}

.meter-row {
  margin-top: 1rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--panel-edge);
}
</style>
