// SPDX-License-Identifier: GPL-3.0-or-later

// Package source drives the capture library and publishes frames to the hub.
//
// It owns the capture handle and the thread that reads from it, converting the
// capture library's vocabulary (WEBA_FRAME_* bits, C status codes) into the
// hub's (proto.Flag* bits, Go errors).
package source

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/lovemilk2333/linux-web-audio/internal/capweba"
	"github.com/lovemilk2333/linux-web-audio/internal/hub"
	"github.com/lovemilk2333/linux-web-audio/internal/proto"
)

// Config describes what to capture.
type Config struct {
	SampleRate   int
	Channels     int
	FrameSamples int
	// Sink is the sink whose monitor to capture; empty means the default sink.
	Sink string
	// ReadTimeout is a floor on how long a single read may block. The library
	// paces its output itself, so this only bounds a stalled read. Zero derives
	// a value from the frame duration, which is what a caller normally wants.
	ReadTimeout time.Duration
}

// Validate checks the configuration.
func (c Config) Validate() error {
	if c.SampleRate <= 0 {
		return fmt.Errorf("source: sample rate must be positive, got %d", c.SampleRate)
	}
	if c.Channels <= 0 || c.Channels > 8 {
		return fmt.Errorf("source: channel count must be 1..8, got %d", c.Channels)
	}
	if c.FrameSamples <= 0 {
		return fmt.Errorf("source: frame size must be positive, got %d", c.FrameSamples)
	}
	if c.ReadTimeout < 0 {
		return fmt.Errorf("source: read timeout must not be negative, got %s", c.ReadTimeout)
	}
	return nil
}

// FrameDuration is how much audio one frame carries.
func (c Config) FrameDuration() time.Duration {
	return time.Duration(float64(c.FrameSamples) / float64(c.SampleRate) * float64(time.Second))
}

// Source is a running capture feeding a channel of frames.
type Source struct {
	capture *capweba.Capture
	frames  chan hub.Frame
	log     *slog.Logger
	// info is captured at open time so it stays readable after the capture
	// handle is released.
	info capweba.Info

	stopOnce sync.Once
	stopped  chan struct{}
	done     chan struct{}

	mu        sync.Mutex
	lastError error
	reopens   int
}

// Open starts capturing.
func Open(cfg Config, logger *slog.Logger) (*Source, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}

	libraryCfg := capweba.DefaultConfig()
	libraryCfg.SampleRate = cfg.SampleRate
	libraryCfg.Channels = cfg.Channels
	libraryCfg.FrameSamples = cfg.FrameSamples
	libraryCfg.Sink = cfg.Sink
	libraryCfg.Format = capweba.FormatF32LE
	libraryCfg.FixedRate = true

	capture, err := capweba.Open(libraryCfg)
	if err != nil {
		return nil, err
	}

	s := &Source{
		capture: capture,
		// Buffer a few frames so a momentarily busy consumer does not force
		// the capture thread to drop audio.
		frames:  make(chan hub.Frame, 16),
		log:     logger,
		stopped: make(chan struct{}),
		done:    make(chan struct{}),
	}

	info, err := capture.Info()
	if err != nil {
		_ = capture.Close()
		return nil, err
	}
	s.info = info
	logger.Info("capture opened",
		"sink", info.SinkName,
		"monitor", info.MonitorName,
		"sample_rate", info.SampleRate,
		"channels", info.Channels,
		"frame_samples", info.FrameSamples,
		"frame_duration", cfg.FrameDuration())

	go s.run(cfg)
	return s, nil
}

// Frames yields captured frames until the source is closed.
func (s *Source) Frames() <-chan hub.Frame { return s.frames }

// Close stops capturing and waits for the reader to finish. Idempotent.
func (s *Source) Close() error {
	s.stopOnce.Do(func() {
		close(s.stopped)
		<-s.done
		close(s.frames)
		_ = s.capture.Close()
	})
	return nil
}

// Info reports the capture format and the sink and monitor in use.
//
// It asks the capture library rather than returning what was true at startup,
// because the capture reopens onto a different sink when the default output
// device changes and the reported monitor has to follow it.
func (s *Source) Info() capweba.Info {
	if info, err := s.capture.Info(); err == nil {
		return info
	}
	// Closed, or the library refused; the last known value is the best answer.
	return s.info
}

// Err returns the most recent capture error, if any.
func (s *Source) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastError
}

// Reopens reports how many times the capture stream had to be reopened, which
// happens when the audio device changes or disappears.
func (s *Source) Reopens() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reopens
}

// run reads frames until stopped.
func (s *Source) run(cfg Config) {
	defer close(s.done)

	frameDuration := cfg.FrameDuration()
	// Wait comfortably longer than one frame so a late frame is still caught
	// rather than reported as a timeout.
	readTimeout := max(4*frameDuration, cfg.ReadTimeout)

	for {
		select {
		case <-s.stopped:
			return
		default:
		}

		samples, info, err := s.capture.ReadFrame(readTimeout)
		if err != nil {
			if errors.Is(err, capweba.ErrTimeout) {
				// The library only reports a timeout when fixed-rate output is
				// off, so this means a genuine gap rather than silence.
				s.log.Warn("capture read timed out", "timeout", readTimeout)
				continue
			}
			s.recordError(err)
			s.log.Error("capture read failed, stopping", "error", err)
			return
		}

		// A fresh buffer per frame, because the library hands back the same
		// slice on every read and the hub may still be encoding the previous
		// frame when the next read overwrites it. At 50 frames per second this
		// is a few hundred kilobytes per second of short-lived allocation,
		// which does not justify a buffer pool.
		pcm := make([]float32, len(samples))
		copy(pcm, samples)

		flags := mapFlags(info.Flags)
		if info.Flags&capweba.FlagReinit != 0 {
			s.mu.Lock()
			s.reopens++
			n := s.reopens
			s.mu.Unlock()
			s.log.Warn("capture stream was reopened, likely a device change", "reopens", n)
		}

		select {
		case s.frames <- hub.Frame{PCM: pcm, Flags: flags, Timestamp: time.Now()}:
		case <-s.stopped:
			return
		}
	}
}

func (s *Source) recordError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastError = err
}

// mapFlags translates capture-library frame flags into wire flags.
//
// A reopened stream is reported as a discontinuity: from the listener's point of
// view the audio is no longer continuous across it, whatever the reason.
func mapFlags(webaFlags uint32) uint8 {
	var flags uint8
	if webaFlags&capweba.FlagDiscontinuity != 0 || webaFlags&capweba.FlagReinit != 0 {
		flags |= proto.FlagDiscontinuity
	}
	if webaFlags&capweba.FlagSilence != 0 {
		flags |= proto.FlagSilence
	}
	if webaFlags&capweba.FlagUnderrun != 0 {
		flags |= proto.FlagUnderrun
	}
	return flags
}
