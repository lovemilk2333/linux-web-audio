<!-- SPDX-License-Identifier: BSD-3-Clause -->
<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** Loudest sample in the last report, 0..1. */
  peak: number
  active: boolean
}>()

/**
 * A level meter belongs on a decibel scale, not a linear one: a linear bar
 * spends most of its length on the top few dB and looks dead at ordinary
 * listening levels.
 */
const percent = computed(() => {
  if (!props.active) return 0
  const peak = Math.max(props.peak, 0)
  if (peak <= 0.0001) return 0
  const db = 20 * Math.log10(peak)
  // -60 dB at the left edge, 0 dB at the right.
  const normalised = (db + 60) / 60
  return Math.min(100, Math.max(0, normalised * 100))
})

const label = computed(() => {
  if (!props.active) return 'idle'
  if (props.peak <= 0.0001) return 'silent'
  return `${(20 * Math.log10(props.peak)).toFixed(1)} dB`
})

const tone = computed(() => (percent.value > 92 ? 'hot' : percent.value > 70 ? 'warm' : 'ok'))
</script>

<template>
  <div class="meter" :class="{ inactive: !active }">
    <div class="track">
      <div class="fill" :class="tone" :style="{ width: percent + '%' }" />
      <!-- Marks where the meter would start clipping. -->
      <div class="mark" style="left: 92%" />
    </div>
    <span class="label">{{ label }}</span>
  </div>
</template>

<style scoped>
.meter {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.track {
  position: relative;
  flex: 1;
  height: 10px;
  border-radius: 5px;
  background: var(--track);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 5px;
  transition: width 80ms linear;
}

.fill.ok {
  background: linear-gradient(90deg, var(--ok-dim), var(--ok));
}
.fill.warm {
  background: linear-gradient(90deg, var(--ok), var(--warm));
}
.fill.hot {
  background: linear-gradient(90deg, var(--warm), var(--hot));
}

.mark {
  position: absolute;
  top: 0;
  width: 1px;
  height: 100%;
  background: var(--mark);
}

.label {
  min-width: 4.5rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 0.8rem;
  color: var(--muted);
}

.inactive .label {
  color: var(--faint);
}
</style>
