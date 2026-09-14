// SPDX-License-Identifier: GPL-3.0-or-later

// Package capweba binds the libwebaudio C ABI.
//
// It is the only package that touches C. Everything above it works with Go
// types, so the rest of the program can be tested without building the capture
// library — see the note in the README about the build order.
//
// The library is linked directly rather than dlopen'ed, which is why the Go
// build needs capture/build/libwebaudio.so to exist first. Run `make lib`.
package capweba

/*
#cgo CFLAGS: -I${SRCDIR}/../../capture/include
#cgo LDFLAGS: -L${SRCDIR}/../../capture/build -lwebaudio -Wl,-rpath,${SRCDIR}/../../capture/build
#include <stdlib.h>
#include "webacapture.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"sync"
	"time"
	"unsafe"
)

// Format is a sample format accepted by the capture library.
type Format int

const (
	FormatF32LE Format = Format(C.WEBA_SAMPLE_F32LE)
	FormatS16LE Format = Format(C.WEBA_SAMPLE_S16LE)
	FormatS32LE Format = Format(C.WEBA_SAMPLE_S32LE)
)

// String names the format.
func (f Format) String() string {
	switch f {
	case FormatF32LE:
		return "f32le"
	case FormatS16LE:
		return "s16le"
	case FormatS32LE:
		return "s32le"
	}
	return fmt.Sprintf("format(%d)", int(f))
}

// Capture frame flags, mirroring the WEBA_FRAME_* constants.
const (
	FlagDiscontinuity = uint32(C.WEBA_FRAME_DISCONTINUITY)
	FlagSilence       = uint32(C.WEBA_FRAME_SILENCE)
	FlagUnderrun      = uint32(C.WEBA_FRAME_UNDERRUN)
	FlagReinit        = uint32(C.WEBA_FRAME_REINIT)
)

// ErrTimeout means no frame was available within the caller's timeout. The
// capture library synthesizes silence rather than timing out when fixed-rate
// output is on, so this is unusual in practice.
var ErrTimeout = errors.New("capweba: no frame within the timeout")

// Error is a failure reported by the capture library.
type Error struct {
	Op     string
	Status int
	Detail string
}

func (e *Error) Error() string {
	msg := fmt.Sprintf("capweba: %s failed (%s)", e.Op, cString(C.weba_strerror(C.int(e.Status))))
	if e.Detail != "" {
		msg += ": " + e.Detail
	}
	return msg
}

// cString converts a C string to a Go string, treating NULL as empty.
func cString(s *C.char) string {
	if s == nil {
		return ""
	}
	return C.GoString(s)
}

// Config describes the capture to open. The zero value is not valid; use
// DefaultConfig and override what you need.
type Config struct {
	SampleRate   int
	Channels     int
	Format       Format
	FrameSamples int
	// Sink is the sink whose monitor to capture. Empty means the default sink,
	// re-resolved whenever the stream is reopened.
	Sink string
	// QueueFrames is the internal frame queue depth.
	QueueFrames int
	// FixedRate makes the library synthesize silence when no audio arrives, so
	// the frame cadence holds even while the desktop is silent.
	FixedRate bool
	// SinkRecheck is how often to check whether the default sink has changed.
	// Zero uses the library default of one second. Only meaningful when Sink is
	// empty, since a pinned sink is never followed away from.
	SinkRecheck time.Duration
}

// DefaultConfig mirrors weba_config_defaults: 48 kHz, stereo, float32, 20 ms.
func DefaultConfig() Config {
	var cfg C.weba_config
	C.weba_config_defaults(&cfg)
	return Config{
		SampleRate:   int(cfg.sample_rate),
		Channels:     int(cfg.channels),
		Format:       Format(cfg.format),
		FrameSamples: int(cfg.frame_samples),
		QueueFrames:  int(cfg.ring_frames),
		FixedRate:    cfg.fixed_rate != 0,
		SinkRecheck:  time.Duration(cfg.sink_recheck_ms) * time.Millisecond,
	}
}

// Info describes the capture actually in use.
type Info struct {
	SampleRate   int
	Channels     int
	FrameSamples int
	Format       Format
	SinkName     string
	MonitorName  string
}

// FrameInfo carries per-frame metadata.
type FrameInfo struct {
	// Flags is a bitwise OR of the Flag* constants.
	Flags uint32
	// DroppedFrames counts frames discarded by queue overflow since the
	// previous read.
	DroppedFrames uint32
}

// Capture is an open capture stream.
type Capture struct {
	// mu guards the handle, so a Close on one goroutine cannot pull the handle
	// out from under an Info or ReadFrame on another.
	mu           sync.Mutex
	ptr          *C.weba_capture
	frameSamples int
	channels     int
	pcm          []float32
	closed       bool
}

// Version returns the capture library's version string.
func Version() string {
	return cString(C.weba_version_string())
}

// Open creates and starts a capture.
func Open(cfg Config) (*Capture, error) {
	if cfg.SampleRate <= 0 || cfg.Channels <= 0 || cfg.FrameSamples <= 0 {
		return nil, fmt.Errorf("capweba: invalid configuration %+v", cfg)
	}

	c := &C.weba_config{
		sample_rate:     C.uint32_t(cfg.SampleRate),
		channels:        C.uint32_t(cfg.Channels),
		format:          C.weba_sample_format(cfg.Format),
		frame_samples:   C.uint32_t(cfg.FrameSamples),
		ring_frames:     C.uint32_t(cfg.QueueFrames),
		fixed_rate:      boolToCInt(cfg.FixedRate),
		sink_recheck_ms: C.uint32_t(cfg.SinkRecheck.Milliseconds()),
	}
	if cfg.Sink != "" {
		c.sink = C.CString(cfg.Sink)
		defer C.free(unsafe.Pointer(c.sink))
	}

	var handle *C.weba_capture
	if status := C.weba_capture_create(c, &handle); status != C.WEBA_OK {
		return nil, &Error{Op: "weba_capture_create", Status: int(status)}
	}

	capture := &Capture{
		ptr:          handle,
		frameSamples: cfg.FrameSamples,
		channels:     cfg.Channels,
		// Allocated once and reused for every read: the library copies into it,
		// and ReadFrame's caller must be done with the slice before the next
		// call. The source layer honours that by handing each frame to the hub
		// through a channel that the hub consumes before the next read.
		pcm: make([]float32, cfg.FrameSamples*cfg.Channels),
	}

	if status := C.weba_capture_start(handle); status != C.WEBA_OK {
		err := capture.error("weba_capture_start", int(status))
		C.weba_capture_destroy(handle)
		return nil, err
	}

	return capture, nil
}

func boolToCInt(v bool) C.int {
	if v {
		return 1
	}
	return 0
}

func (c *Capture) error(op string, status int) error {
	return &Error{Op: op, Status: status, Detail: cString(C.weba_capture_last_error(c.ptr))}
}

// ReadFrame waits up to timeout for one frame and returns the interleaved
// float32 samples.
//
// The returned slice is reused by the next call, so a caller must either
// consume it before reading again or copy it.
func (c *Capture) ReadFrame(timeout time.Duration) ([]float32, FrameInfo, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, FrameInfo{}, errors.New("capweba: capture is closed")
	}
	// The handle stays valid for the duration of the call because Close cannot
	// proceed until the lock is released.
	handle, pcm, frameSamples := c.ptr, c.pcm, c.frameSamples
	c.mu.Unlock()

	var info C.weba_frame_info
	status := C.weba_capture_read_frame(
		handle,
		unsafe.Pointer(&pcm[0]),
		C.uint32_t(frameSamples),
		&info,
		C.int(timeout.Milliseconds()),
	)

	switch status {
	case 1:
		return pcm, FrameInfo{
			Flags:         uint32(info.flags),
			DroppedFrames: uint32(info.dropped_frames),
		}, nil
	case 0:
		return nil, FrameInfo{}, ErrTimeout
	default:
		return nil, FrameInfo{}, c.error("weba_capture_read_frame", int(status))
	}
}

// Info reports the format and the sink and monitor actually in use.
//
// The sink and monitor are read from the library rather than remembered, so
// after the capture reopens onto a different sink this reflects where it is
// capturing now.
func (c *Capture) Info() (Info, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return Info{}, errors.New("capweba: capture is closed")
	}
	handle := c.ptr
	c.mu.Unlock()

	var raw C.weba_format_info
	if status := C.weba_capture_get_format(handle, &raw); status != C.WEBA_OK {
		return Info{}, c.error("weba_capture_get_format", int(status))
	}

	return Info{
		SampleRate:   int(raw.sample_rate),
		Channels:     int(raw.channels),
		FrameSamples: int(raw.frame_samples),
		Format:       Format(raw.format),
		SinkName:     cString(&raw.sink_name[0]),
		MonitorName:  cString(&raw.monitor_name[0]),
	}, nil
}

// Running reports whether the capture thread is still running.
func (c *Capture) Running() bool {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return false
	}
	handle := c.ptr
	c.mu.Unlock()
	return C.weba_capture_is_running(handle) != 0
}

// Close stops the capture and releases it. Idempotent.
func (c *Capture) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	C.weba_capture_destroy(c.ptr)
	c.ptr = nil
	return nil
}
