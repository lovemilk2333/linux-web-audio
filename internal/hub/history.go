package hub

import (
	"fmt"
	"sync"

	"github.com/lovemilk2333/linux-ws-audio/internal/proto"
)

// payloadRef is one codec's encoding of a single frame.
type payloadRef struct {
	codec string
	data  []byte
}

// historyEntry is one frame's worth of stream history: the sequence number and
// timestamp shared by every codec, plus one payload per codec that was active
// when the frame was produced.
type historyEntry struct {
	seq       uint16
	timestamp uint32
	flags     uint8
	payloads  []payloadRef
}

// payloadFor returns the entry's payload for a codec, if it was encoded.
func (e historyEntry) payloadFor(codecName string) ([]byte, bool) {
	for _, p := range e.payloads {
		if p.codec == codecName {
			return p.data, true
		}
	}
	return nil, false
}

// history is a bounded ring of recent packets, used to serve a client that
// reconnects and asks to resume from a sequence number it already saw.
//
// One sequence namespace is shared by all codecs, because the sequence number
// belongs to the captured frame rather than to any particular encoding of it.
type history struct {
	mu       sync.Mutex
	entries  []historyEntry
	start    int // index of the oldest entry
	count    int
	capacity int
}

func newHistory(capacity int) *history {
	if capacity < 1 {
		capacity = 1
	}
	return &history{
		entries:  make([]historyEntry, capacity),
		capacity: capacity,
	}
}

// append adds an entry, discarding the oldest when full.
func (h *history) append(e historyEntry) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.count == h.capacity {
		// Overwrite the oldest slot and advance past it.
		h.entries[h.start] = e
		h.start = (h.start + 1) % h.capacity
		return
	}

	h.entries[(h.start+h.count)%h.capacity] = e
	h.count++
}

// bounds reports the oldest and newest sequence numbers held. ok is false when
// nothing has been recorded yet.
func (h *history) bounds() (oldest, latest uint16, ok bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.count == 0 {
		return 0, 0, false
	}
	return h.entries[h.start].seq, h.entries[(h.start+h.count-1)%h.capacity].seq, true
}

// replay returns the packets for codecName covering the inclusive sequence
// range [from, to], in order. Entries missing that codec's payload are skipped.
func (h *history) replay(codecName string, from, to uint16) []Packet {
	h.mu.Lock()
	defer h.mu.Unlock()

	var out []Packet
	for i := range h.count {
		e := h.entries[(h.start+i)%h.capacity]
		if !proto.SeqInWindow(e.seq, from, to) {
			continue
		}
		data, ok := e.payloadFor(codecName)
		if !ok {
			continue
		}
		out = append(out, Packet{
			Seq:       e.seq,
			Timestamp: e.timestamp,
			Flags:     e.flags | proto.FlagCatchup,
			Payload:   data,
		})
	}
	return out
}

// capacityOf reports the configured number of entries.
func (h *history) capacityOf() int { return h.capacity }

// String renders the bounds for logs.
func (h *history) String() string {
	oldest, latest, ok := h.bounds()
	if !ok {
		return "history(empty)"
	}
	return fmt.Sprintf("history(%d..%d)", oldest, latest)
}
