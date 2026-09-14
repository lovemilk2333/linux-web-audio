// SPDX-License-Identifier: GPL-3.0-or-later

// Package hub turns captured audio frames into a broadcast stream.
//
// It assigns each captured frame a sequence number and a sample timestamp,
// encodes it once per codec that has a subscriber, records it in a bounded
// history for late joiners, and fans it out to every subscriber's queue. A slow
// subscriber never blocks the capture loop: its queue is bounded and overflows
// according to a configured policy.
package hub

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lovemilk2333/linux-web-audio/internal/codec"
	"github.com/lovemilk2333/linux-web-audio/internal/proto"
)

// Frame is one captured frame of interleaved float32 PCM. Flags carries
// proto.Flag* bits describing how the frame was obtained.
type Frame struct {
	PCM       []float32
	Flags     uint8
	Timestamp time.Time
}

// FrameSource is the capture side of the pipeline. The concrete
// implementation wraps the capture library; tests supply a synthetic one.
type FrameSource interface {
	// Frames yields captured frames until the source is closed.
	Frames() <-chan Frame
	// Close stops capture and releases the source.
	Close() error
}

// SlowPolicy decides what happens to a subscriber that cannot keep up.
type SlowPolicy int

const (
	// FastForward discards the subscriber's backlog and delivers the newest
	// packet, keeping latency bounded. This is the default.
	FastForward SlowPolicy = iota
	// DropNewest keeps the backlog and discards incoming packets.
	DropNewest
	// Disconnect closes the subscriber's stream.
	Disconnect
)

// ParseSlowPolicy parses a --slow-client value.
func ParseSlowPolicy(name string) (SlowPolicy, error) {
	switch name {
	case "fast-forward":
		return FastForward, nil
	case "drop":
		return DropNewest, nil
	case "disconnect":
		return Disconnect, nil
	default:
		return FastForward, fmt.Errorf("unknown slow-client policy %q, expected fast-forward, drop or disconnect", name)
	}
}

func (p SlowPolicy) String() string {
	switch p {
	case FastForward:
		return "fast-forward"
	case DropNewest:
		return "drop"
	case Disconnect:
		return "disconnect"
	}
	return "unknown"
}

// Config configures a Hub.
type Config struct {
	// Codec is the codec used by clients that do not request one.
	Codec string
	// SampleRate, Channels and FrameSamples describe the capture format.
	SampleRate   int
	Channels     int
	FrameSamples int
	// Encoder settings, applied to every codec that supports them.
	Bitrate    int
	Complexity int
	VBR        bool
	DTX        bool
	FEC        bool
	// HistoryPackets is how many recent packets are kept for catch-up.
	HistoryPackets int
	// ClientQueue is how many packets a subscriber's queue holds.
	ClientQueue int
	// SlowClient is the overflow policy for a subscriber that falls behind.
	SlowClient SlowPolicy
}

// Validate checks the configuration.
func (c Config) Validate() error {
	encCfg := codec.Config{
		SampleRate:   c.SampleRate,
		Channels:     c.Channels,
		FrameSamples: c.FrameSamples,
		Bitrate:      c.Bitrate,
		Complexity:   c.Complexity,
	}
	if err := encCfg.Validate(); err != nil {
		return err
	}
	if c.Codec == "" {
		return errors.New("hub: a default codec is required")
	}
	if _, ok := codec.Lookup(c.Codec); !ok {
		return fmt.Errorf("hub: unknown default codec %q, supported: %s",
			c.Codec, strings.Join(codec.Names(), ", "))
	}
	if c.ClientQueue < 1 {
		return fmt.Errorf("hub: client queue must be at least 1, got %d", c.ClientQueue)
	}
	if c.HistoryPackets < 0 {
		return fmt.Errorf("hub: history size must not be negative, got %d", c.HistoryPackets)
	}
	return nil
}

// ErrSeqOutOfRange reports that a requested resume point is no longer held, or
// is ahead of what has been produced.
var ErrSeqOutOfRange = errors.New("hub: requested sequence number is outside the history window")

// ErrNotStarted reports that no frame has been produced yet.
var ErrNotStarted = errors.New("hub: no audio has been produced yet")

// hubEncoder is a live encoder plus the number of subscribers using it.
type hubEncoder struct {
	enc  codec.Encoder
	refs int
}

// Hub is the broadcast core. Create one with New and drive it with Run.
type Hub struct {
	cfg      Config
	encCfg   codec.Config
	log      *slog.Logger
	history  *history
	startedA atomic.Bool

	// mu guards everything below. Encoding happens under it too: a 20 ms frame
	// takes tens of microseconds to encode, so the lock is held for a rounding
	// error of the time and Subscribe never waits meaningfully. A genuinely
	// slow codec would want an owner goroutine instead.
	mu          sync.Mutex
	encoders    map[string]*hubEncoder
	subscribers map[*Subscriber]struct{}
	nextSeq     uint16
	timestamp   uint32
	produced    uint64

	// Counters for /audio/info.
	packetsSent atomic.Uint64
	frames      atomic.Uint64
}

// New creates a Hub.
func New(cfg Config, logger *slog.Logger) (*Hub, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	h := &Hub{
		cfg: cfg,
		encCfg: codec.Config{
			SampleRate:   cfg.SampleRate,
			Channels:     cfg.Channels,
			FrameSamples: cfg.FrameSamples,
			Bitrate:      cfg.Bitrate,
			Complexity:   cfg.Complexity,
			VBR:          cfg.VBR,
			DTX:          cfg.DTX,
			FEC:          cfg.FEC,
		},
		log:         logger,
		history:     newHistory(cfg.HistoryPackets),
		encoders:    map[string]*hubEncoder{},
		subscribers: map[*Subscriber]struct{}{},
	}

	// The hub holds a reference of its own to the default codec's encoder, so
	// that encoder is never released. That keeps the recorded history current
	// even when the last listener has gone away, which is what makes resuming
	// from a sequence number work for a client that reconnects. Codecs other
	// than the default are still created on demand and released when unused.
	enc, err := codec.New(cfg.Codec, h.encCfg)
	if err != nil {
		return nil, err
	}
	h.encoders[cfg.Codec] = &hubEncoder{enc: enc, refs: 1}

	return h, nil
}

// Close releases the hub's own codec reference and any encoders still open.
// Call it once Run has returned.
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()

	for name, st := range h.encoders {
		if err := st.enc.Close(); err != nil {
			h.log.Warn("closing encoder failed", "codec", name, "error", err)
		}
		delete(h.encoders, name)
	}
}

// DefaultCodec returns the codec used by clients that do not request one.
func (h *Hub) DefaultCodec() string { return h.cfg.Codec }

// Config returns the hub's configuration.
func (h *Hub) Config() Config { return h.cfg }

// Run consumes frames from src until the context is cancelled or the source
// closes. It is the only place that produces packets.
func (h *Hub) Run(ctx context.Context, src FrameSource) error {
	frames := src.Frames()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case frame, ok := <-frames:
			if !ok {
				return nil
			}
			h.process(frame)
		}
	}
}

// process turns one captured frame into packets for every active codec and
// fans them out.
func (h *Hub) process(frame Frame) {
	h.mu.Lock()
	defer h.mu.Unlock()

	seq := h.nextSeq
	h.nextSeq++
	timestamp := h.timestamp
	h.timestamp += uint32(h.cfg.FrameSamples)
	h.produced++

	if len(h.encoders) == 0 {
		// Nothing is listening. Advance the timeline but do not encode or
		// record, so a client joining later still starts at a sane sequence
		// number and nothing accumulates on behalf of absent listeners.
		h.startedA.Store(true)
		h.frames.Add(1)
		return
	}

	entry := historyEntry{seq: seq, timestamp: timestamp, flags: frame.Flags}

	for name, st := range h.encoders {
		payload, err := st.enc.Encode(frame.PCM)
		if err != nil {
			h.log.Error("encoding failed", "codec", name, "error", err)
			continue
		}
		// Encoders reuse their buffer, so the payload has to be copied before
		// it is shared with subscribers and stored in history.
		data := bytes.Clone(payload)
		entry.payloads = append(entry.payloads, payloadRef{codec: name, data: data})
	}

	// Recorded even when no subscriber wanted it, so a client that reconnects
	// can still be served the recent past.
	h.history.append(entry)
	h.startedA.Store(true)
	h.frames.Add(1)

	for sub := range h.subscribers {
		data, ok := entry.payloadFor(sub.codec)
		if !ok {
			continue
		}
		// push() applies any flags owed from an earlier overflow.
		sub.push(Packet{
			Seq:       seq,
			Timestamp: timestamp,
			Flags:     frame.Flags,
			Payload:   data,
		})
	}
}

// Subscribe registers a listener on a codec.
//
// fromSeq, when non-nil, requests that the stream resume at that sequence
// number: the recent history from there is queued for replay before the live
// stream begins. The error is ErrSeqOutOfRange when the requested point is no
// longer held, so the caller can answer 416.
func (h *Hub) Subscribe(codecName string, fromSeq *uint16) (*Subscriber, error) {
	if codecName == "" {
		codecName = h.cfg.Codec
	}
	if _, ok := codec.Lookup(codecName); !ok {
		return nil, fmt.Errorf("unknown codec %q, supported: %s", codecName, strings.Join(codec.Names(), ", "))
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	var catchup []Packet
	if fromSeq != nil {
		oldest, latest, ok := h.history.bounds()
		if !ok {
			// Nothing has been recorded, so the requested point cannot be
			// served. That is a range problem, not a server fault.
			return nil, fmt.Errorf("%w: requested %d, no packets are held", ErrSeqOutOfRange, *fromSeq)
		}
		if !proto.SeqInWindow(*fromSeq, oldest, latest) {
			return nil, fmt.Errorf("%w: requested %d, available %d..%d",
				ErrSeqOutOfRange, *fromSeq, oldest, latest)
		}
		catchup = h.history.replay(codecName, *fromSeq, latest)
	}

	sub := &Subscriber{
		codec:   codecName,
		ch:      make(chan Packet, h.cfg.ClientQueue),
		policy:  h.cfg.SlowClient,
		closed:  make(chan struct{}),
		catchup: catchup,
		hub:     h,
	}

	if st, ok := h.encoders[codecName]; ok {
		st.refs++
	} else {
		enc, err := codec.New(codecName, h.encCfg)
		if err != nil {
			return nil, err
		}
		h.encoders[codecName] = &hubEncoder{enc: enc, refs: 1}
		h.log.Info("codec enabled", "codec", codecName, "subscribers", 1)
	}

	h.subscribers[sub] = struct{}{}
	h.log.Info("subscriber added",
		"codec", codecName, "subscribers", len(h.subscribers),
		"resumed", fromSeq != nil, "replay_packets", len(catchup))
	return sub, nil
}

// unsubscribe removes a subscriber and releases its codec when it was the last
// user of it.
func (h *Hub) unsubscribe(sub *Subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.subscribers[sub]; !ok {
		return
	}
	delete(h.subscribers, sub)

	st, ok := h.encoders[sub.codec]
	if !ok {
		return
	}
	st.refs--
	if st.refs > 0 {
		return
	}
	// Last user of this codec: drop the entry first so a subscribe racing with
	// the close below builds a fresh encoder rather than resurrecting this one.
	delete(h.encoders, sub.codec)
	if err := st.enc.Close(); err != nil {
		h.log.Warn("closing encoder failed", "codec", sub.codec, "error", err)
	}
	h.log.Info("codec disabled", "codec", sub.codec)
}

// Stats describes the hub's current state, for /audio/info.
type Stats struct {
	Codec           string
	Codecs          []string
	SampleRate      int
	Channels        int
	FrameSamples    int
	FrameDurationMS float64
	Bitrate         int
	CurrentSeq      uint16
	OldestSeq       uint16
	HistoryPackets  int
	Started         bool
	Subscribers     int
	Frames          uint64
	Encoders        []string
}

// Stats returns a snapshot of the hub's state.
func (h *Hub) Stats() Stats {
	h.mu.Lock()
	oldest, _, haveHistory := h.history.bounds()
	currentSeq := h.nextSeq
	h.mu.Unlock()

	encoders := make([]string, 0, 4)
	h.mu.Lock()
	for name := range h.encoders {
		encoders = append(encoders, name)
	}
	subscribers := len(h.subscribers)
	h.mu.Unlock()

	stats := Stats{
		Codec:           h.cfg.Codec,
		Codecs:          codec.Names(),
		SampleRate:      h.cfg.SampleRate,
		Channels:        h.cfg.Channels,
		FrameSamples:    h.cfg.FrameSamples,
		FrameDurationMS: h.encCfg.FrameDurationMS(),
		Bitrate:         h.cfg.Bitrate,
		HistoryPackets:  h.history.capacityOf(),
		Started:         h.startedA.Load(),
		Subscribers:     subscribers,
		Frames:          h.frames.Load(),
		Encoders:        encoders,
	}
	if haveHistory {
		// The next sequence number is one past the newest packet stored, which
		// is what a client should ask for to continue without a gap.
		stats.CurrentSeq = currentSeq - 1
		stats.OldestSeq = oldest
	} else {
		stats.CurrentSeq = currentSeq - 1
	}
	return stats
}
