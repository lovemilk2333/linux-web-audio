<!-- SPDX-License-Identifier: BSD-3-Clause -->
<script setup lang="ts">
export interface LogEntry {
  id: number
  at: string
  kind: 'open' | 'closed' | 'gap' | 'notice' | 'error'
  message: string
  missing?: number
}

defineProps<{
  entries: LogEntry[]
}>()

const tone: Record<LogEntry['kind'], string> = {
  open: 'ok',
  closed: 'muted',
  gap: 'warn',
  notice: 'muted',
  error: 'bad',
}
</script>

<template>
  <div class="panel log">
    <h2>Events</h2>
    <p v-if="entries.length === 0" class="empty">
      Nothing yet. Connecting, reconnecting and any gaps in the audio appear here.
    </p>
    <ul v-else>
      <li v-for="entry in entries" :key="entry.id">
        <span class="at mono">{{ entry.at }}</span>
        <span class="kind" :class="tone[entry.kind]">{{ entry.kind }}</span>
        <span class="message">
          {{ entry.message }}
          <template v-if="entry.missing">
            <span class="missing">— {{ entry.missing }} packets were never delivered</span>
          </template>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.log ul {
  list-style: none;
  margin: 0.7rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.3rem;
  max-height: 16rem;
  overflow-y: auto;
}

.log li {
  display: grid;
  grid-template-columns: 5.5rem 6rem 1fr;
  gap: 0.6rem;
  align-items: baseline;
  font-size: 0.82rem;
}

.at {
  color: var(--faint);
  font-size: 0.76rem;
}

.kind {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.kind.ok {
  color: var(--ok);
}
.kind.warn {
  color: var(--warm);
}
.kind.bad {
  color: var(--danger);
}
.kind.muted {
  color: var(--faint);
}

.message {
  min-width: 0;
  overflow-wrap: anywhere;
}

.missing {
  color: var(--warm);
}

.empty {
  margin: 0.7rem 0 0;
  font-size: 0.82rem;
  color: var(--faint);
}
</style>
