<!-- SPDX-License-Identifier: BSD-3-Clause -->
<script setup lang="ts">
import { computed } from 'vue'

import type { StreamStats } from '../stats'
import type { PlayerStatus } from '../audio/player'

const props = defineProps<{
  stats: StreamStats
  player: PlayerStatus
  connected: boolean
  /** Replayed packets dropped undecoded because the buffer was already full. */
  skipped: number
  /** Refreshes the display; the panels are read-only snapshots. */
  tick: number
}>()

/** Bits per second reads in kbps and Mbps, not KiB and MiB. */
function bitsPerSecond(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} Mbps`
  return `${(value / 1000).toFixed(0)} kbps`
}

/* Every computed below reads props.tick first.
 *
 * The stats object is mutated in place as packets arrive, so a computed that
 * only read it would see the same object reference on every re-evaluation and
 * Vue would treat the result as unchanged, never re-rendering. Reading tick,
 * which the parent increments on a timer, makes the dependency real. */
const summary = computed(() => {
  void props.tick
  return props.stats.summary()
})

const rows = computed(() => {
  void props.tick
  const stats = props.stats
  return [
    { label: 'packets/s', value: summary.value.packetsPerSecond.toFixed(1) },
    { label: 'bitrate', value: bitsPerSecond(summary.value.bytesPerSecond * 8) },
    { label: 'audio', value: `${summary.value.audio.toFixed(2)} s` },
    { label: 'wall clock', value: `${summary.value.elapsed.toFixed(2)} s` },
    {
      label: 'audio / wall',
      value: summary.value.elapsed > 0.5 ? summary.value.ratio.toFixed(4) : '—',
      hint: 'closer to 1.0000 means the stream kept up',
    },
    { label: 'packets', value: stats.packets.toLocaleString() },
    { label: 'sequence', value: stats.firstSeq === null ? '—' : `${stats.firstSeq} → ${stats.lastSeq}` },
  ]
})

const health = computed(() => {
  void props.tick
  const stats = props.stats
  const items: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' }[] = []

  if (stats.gaps === 0 && stats.outOfOrder === 0 && stats.duplicates === 0) {
    items.push({ label: 'sequence', value: 'contiguous', tone: 'ok' })
  } else {
    const parts: string[] = []
    if (stats.gaps) parts.push(`${stats.gaps} gaps (${stats.missing} packets)`)
    if (stats.duplicates) parts.push(`${stats.duplicates} duplicates`)
    if (stats.outOfOrder) parts.push(`${stats.outOfOrder} out of order`)
    items.push({ label: 'sequence', value: parts.join(', '), tone: stats.gaps ? 'bad' : 'warn' })
  }

  items.push(
    stats.clockJumps === 0
      ? { label: 'media clock', value: 'every step exact', tone: 'ok' }
      : {
          label: 'media clock',
          value: `${stats.clockJumps} steps off`,
          tone: 'warn',
        },
  )

  items.push(
    props.player.underruns === 0
      ? { label: 'playback', value: 'no dropouts', tone: 'ok' }
      : {
          label: 'playback',
          value: `${props.player.underruns} dropouts`,
          tone: 'warn',
        },
  )

  if (props.player.droppedFrames > 0) {
    const seconds = props.player.droppedFrames / 48000
    items.push({
      label: 'latency trim',
      value: `${seconds.toFixed(2)} s discarded`,
      tone: 'warn',
    })
  }

  if (stats.catchup > 0) {
    items.push({ label: 'replayed', value: `${stats.catchup} packets`, tone: 'ok' })
  }

  if (props.skipped > 0) {
    // Not a fault: a replayed backlog larger than the buffer is deliberately
    // not decoded, so that playback resumes at the live edge instead of a
    // second behind it.
    items.push({ label: 'replay skipped', value: `${props.skipped} packets`, tone: 'ok' })
  }

  if (stats.silence > 0) {
    items.push({ label: 'silence', value: `${stats.silence} packets`, tone: 'ok' })
  }

  if (stats.discontinuity > 0) {
    items.push({ label: 'gaps flagged', value: `${stats.discontinuity} packets`, tone: 'warn' })
  }

  return items
})

const bufferPercent = computed(() => {
  void props.tick
  // Relative to a second of buffer, which is well past any sane target.
  return Math.min(100, (props.player.bufferedMs / 1000) * 100)
})
</script>

<template>
  <div class="stats panel">
    <h2>Stream</h2>
    <dl class="grid">
      <template v-for="row in rows" :key="row.label">
        <dt>{{ row.label }}</dt>
        <dd class="mono" :title="row.hint ?? ''">{{ row.value }}</dd>
      </template>
    </dl>

    <h2 class="spaced">
      Playback buffer
      <span class="mono buffer-value">{{ player.bufferedMs.toFixed(0) }} ms</span>
    </h2>
    <div class="buffer">
      <div class="buffer-fill" :style="{ width: bufferPercent + '%' }" />
    </div>

    <h2 class="spaced">Health</h2>
    <ul class="health">
      <li v-for="item in health" :key="item.label">
        <span class="dot" :class="item.tone" />
        <span class="health-label">{{ item.label }}</span>
        <span class="health-value">{{ item.value }}</span>
      </li>
    </ul>

    <p v-if="!connected" class="note">Not connected. The numbers above are from the last session.</p>
  </div>
</template>

<style scoped>
.stats h2 {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.spaced {
  margin-top: 1.1rem;
}

.grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.2rem 1rem;
  margin: 0.6rem 0 0;
}

dt {
  color: var(--muted);
  font-size: 0.82rem;
}

dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.buffer-value {
  font-size: 0.8rem;
  color: var(--text);
  text-transform: none;
  letter-spacing: 0;
}

.buffer {
  height: 6px;
  margin-top: 0.5rem;
  border-radius: 3px;
  background: var(--track);
  overflow: hidden;
}

.buffer-fill {
  height: 100%;
  background: var(--accent);
  transition: width 120ms linear;
}

.health {
  list-style: none;
  margin: 0.6rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.3rem;
}

.health li {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.85rem;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot.ok {
  background: var(--ok);
}
.dot.warn {
  background: var(--warm);
}
.dot.bad {
  background: var(--hot);
}

.health-label {
  color: var(--muted);
}

.health-value {
  font-variant-numeric: tabular-nums;
}

.note {
  margin: 0.9rem 0 0;
  font-size: 0.8rem;
  color: var(--faint);
}
</style>
