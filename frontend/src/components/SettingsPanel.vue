<!-- SPDX-License-Identifier: BSD-3-Clause -->
<script setup lang="ts">
defineProps<{
  targetMs: number
  /** Smallest sensible buffer: two frames, since audio arrives one frame at a time. */
  minTargetMs: number
  /** Buffers are measured in whole frames. */
  targetStepMs: number
  resume: boolean
  theme: 'system' | 'light' | 'dark'
  repeatable: boolean
}>()

const emit = defineEmits<{
  'update:targetMs': [number]
  'update:resume': [boolean]
  'update:theme': ['system' | 'light' | 'dark']
  disconnectNow: []
}>()
</script>

<template>
  <div class="panel">
    <h2>Playback</h2>

    <div class="row">
      <div class="label-block">
        <label for="target">Buffer target</label>
        <p class="hint">
          How much audio to hold before playing starts. This is also the delay you hear: the buffer
          cannot fill faster than the source produces it, so a live stream always lags by roughly
          this much. More absorbs jitter and stalls; less gets you closer to live. Past twice this,
          the oldest audio is discarded to keep the delay from growing.
        </p>
        <p class="hint detail">
          The step is one frame and the floor is {{ minTargetMs }} ms here, which is the default:
          as current as the stream can be without dropping blocks. Audio arrives a frame at
          a time, so a smaller step asks for a fraction of a packet; and the audio thread is handed
          128-sample blocks, so a buffer of only a frame or two cannot cover a block plus the wait
          for the next packet — and every packet is decoded on the main thread before it reaches
          the audio thread, which adds jitter of its own. Below this floor the dropouts are
          continuous.
        </p>
      </div>
      <div class="control">
        <input
          id="target"
          type="range"
          :min="minTargetMs"
          :max="1500"
          :step="targetStepMs"
          :value="targetMs"
          @input="emit('update:targetMs', Number(($event.target as HTMLInputElement).value))"
        />
        <span class="value mono">{{ targetMs }} ms</span>
      </div>
    </div>

    <div class="row">
      <div class="label-block">
        <label for="resume">Resume after a drop</label>
        <p class="hint">
          Reconnect with <code>?from_seq</code> so the server replays what was missed, instead of
          rejoining at the live edge with a hole in the audio.
        </p>
      </div>
      <div class="control">
        <input
          id="resume"
          type="checkbox"
          :checked="resume"
          class="checkbox"
          @change="emit('update:resume', ($event.target as HTMLInputElement).checked)"
        />
      </div>
    </div>

    <div class="row">
      <div class="label-block">
        <label for="theme">Theme</label>
      </div>
      <div class="control">
        <select
          id="theme"
          :value="theme"
          @change="emit('update:theme', ($event.target as HTMLSelectElement).value as 'system')"
        >
          <option value="system">Follow system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
    </div>

    <h2 class="spaced">Recovery</h2>
    <div class="row">
      <div class="label-block">
        <p class="hint">
          Drop the connection now to watch the resume path work. The reader reconnects on its own
          and, with resume enabled, replays the missed packets.
        </p>
      </div>
      <div class="control">
        <button :disabled="!repeatable" @click="emit('disconnectNow')">Drop connection</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  padding: 0.7rem 0;
  border-bottom: 1px solid var(--panel-edge);
}

.row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.spaced {
  margin-top: 1.2rem;
}

.label-block {
  flex: 1;
  min-width: 0;
}

.label-block label {
  margin-bottom: 0.2rem;
}

.hint {
  margin: 0;
  font-size: 0.78rem;
  color: var(--muted);
}

.detail {
  margin-top: 0.35rem;
  color: var(--faint);
}

.control {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding-top: 1.2rem;
}

.control input[type='range'] {
  width: 9rem;
}

.control input[type='checkbox'] {
  width: 1.1rem;
  height: 1.1rem;
  accent-color: var(--accent);
}

.control select {
  width: auto;
}

.value {
  min-width: 4rem;
  text-align: right;
  font-size: 0.82rem;
  color: var(--muted);
}
</style>
