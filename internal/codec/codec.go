// SPDX-License-Identifier: GPL-3.0-or-later

// Package codec encodes captured PCM into the payload carried by the wire
// format.
//
// Codecs are registered by name and selected with the server's --codec flag or
// a client's ?codec= parameter. Several can be active at once: the hub encodes
// each captured frame once per codec that has at least one subscriber.
package codec

import (
	"fmt"
	"sort"
	"strings"
)

// Config describes the stream an encoder is being built for.
type Config struct {
	// SampleRate is the capture rate in Hz.
	SampleRate int
	// Channels is the interleaved channel count.
	Channels int
	// FrameSamples is the number of frames per encoded packet.
	FrameSamples int
	// Bitrate is the target bitrate in bits per second, for codecs that have
	// one. Zero means the codec's own default.
	Bitrate int
	// Complexity is the encoder effort, for codecs that have one.
	Complexity int
	// VBR selects variable bitrate where supported. Opus is run in CBR by
	// default, matching Sunshine.
	VBR bool
	// DTX enables discontinuous transmission where supported.
	DTX bool
	// FEC enables in-band forward error correction where supported.
	FEC bool
}

// FrameDurationMS reports the duration of one frame in milliseconds.
func (c Config) FrameDurationMS() float64 {
	if c.SampleRate == 0 {
		return 0
	}
	return float64(c.FrameSamples) * 1000 / float64(c.SampleRate)
}

// Validate checks that the configuration is self-consistent.
func (c Config) Validate() error {
	switch {
	case c.SampleRate <= 0:
		return fmt.Errorf("codec: sample rate must be positive, got %d", c.SampleRate)
	case c.Channels <= 0 || c.Channels > 8:
		return fmt.Errorf("codec: channel count must be 1..8, got %d", c.Channels)
	case c.FrameSamples <= 0:
		return fmt.Errorf("codec: frame size must be positive, got %d", c.FrameSamples)
	case c.Bitrate < 0:
		return fmt.Errorf("codec: bitrate must not be negative, got %d", c.Bitrate)
	case c.Complexity < 0:
		return fmt.Errorf("codec: complexity must not be negative, got %d", c.Complexity)
	}
	return nil
}

// Encoder turns one frame of interleaved float32 PCM into one payload.
//
// Encode must not retain pcm after it returns, and the returned slice is only
// valid until the next call: the hub copies it out before fanning out, so
// encoders can and should reuse an internal buffer.
type Encoder interface {
	// Name is the registered codec name.
	Name() string
	// Encode returns the payload for pcm, which holds exactly
	// FrameSamples*Channels samples.
	Encode(pcm []float32) ([]byte, error)
	// Close releases the encoder's resources. It must tolerate being called
	// more than once.
	Close() error
}

// NewFunc builds an encoder for a stream configuration.
type NewFunc func(Config) (Encoder, error)

var registry = map[string]NewFunc{}

// Register adds a codec under name. It panics on a duplicate or empty name,
// since both are programming errors at init time.
func Register(name string, fn NewFunc) {
	if name == "" {
		panic("codec: cannot register an empty name")
	}
	if fn == nil {
		panic("codec: cannot register a nil constructor for " + name)
	}
	if _, exists := registry[name]; exists {
		panic("codec: " + name + " is already registered")
	}
	registry[name] = fn
}

// Lookup returns the constructor registered for name.
func Lookup(name string) (NewFunc, bool) {
	fn, ok := registry[name]
	return fn, ok
}

// Names lists the registered codec names in a stable order.
func Names() []string {
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ParseList validates a comma-separated list of codec names, returning them in
// the order given with duplicates removed.
func ParseList(list string) ([]string, error) {
	var names []string
	seen := map[string]bool{}
	for raw := range strings.SplitSeq(list, ",") {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		if _, ok := Lookup(name); !ok {
			return nil, fmt.Errorf("unknown codec %q, supported codecs: %s",
				name, strings.Join(Names(), ", "))
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("no codec given, supported codecs: %s", strings.Join(Names(), ", "))
	}
	return names, nil
}

// New builds the encoder registered under name.
func New(name string, cfg Config) (Encoder, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	fn, ok := Lookup(name)
	if !ok {
		return nil, fmt.Errorf("unknown codec %q, supported codecs: %s",
			name, strings.Join(Names(), ", "))
	}
	enc, err := fn(cfg)
	if err != nil {
		return nil, fmt.Errorf("codec %s: %w", name, err)
	}
	return enc, nil
}
