// SPDX-License-Identifier: BSD-3-Clause

package codec

import (
	"fmt"

	"github.com/hraban/opus"
)

func init() {
	Register("opus", newOpus)
}

// opusDefaultBitrate matches the bitrate Sunshine uses for a stereo stream.
const opusDefaultBitrate = 96000

// opusEncoder wraps libopus.
type opusEncoder struct {
	enc          *opus.Encoder
	name         string
	frameSamples int
	channels     int
	buf          []byte
}

// newOpus builds an Opus encoder.
//
// Sunshine's settings are the default: the restricted-low-delay application and
// constant bitrate (OPUS_SET_VBR(0)). Variable bitrate is available but off by
// default, so the wire rate stays predictable.
func newOpus(cfg Config) (Encoder, error) {
	if cfg.Channels > 2 {
		// Mapping-family encoders would be needed for 5.1 and 7.1. Rather than
		// fail at the first frame, refuse up front.
		return nil, fmt.Errorf("Opus here supports mono and stereo only, got %d channels", cfg.Channels)
	}

	application, err := opusApplication(cfg)
	if err != nil {
		return nil, err
	}

	enc, err := opus.NewEncoder(cfg.SampleRate, cfg.Channels, application)
	if err != nil {
		return nil, fmt.Errorf("creating the encoder: %w", err)
	}

	bitrate := cfg.Bitrate
	if bitrate == 0 {
		bitrate = opusDefaultBitrate
	}
	if err := enc.SetBitrate(bitrate); err != nil {
		return nil, fmt.Errorf("setting the bitrate to %d: %w", bitrate, err)
	}
	if cfg.Complexity > 0 {
		if err := enc.SetComplexity(cfg.Complexity); err != nil {
			return nil, fmt.Errorf("setting the complexity to %d: %w", cfg.Complexity, err)
		}
	}
	if err := enc.SetVBR(cfg.VBR); err != nil {
		return nil, fmt.Errorf("setting VBR to %v: %w", cfg.VBR, err)
	}
	if cfg.DTX {
		if err := enc.SetDTX(true); err != nil {
			return nil, fmt.Errorf("enabling DTX: %w", err)
		}
	}
	if cfg.FEC {
		if err := enc.SetInBandFEC(true); err != nil {
			return nil, fmt.Errorf("enabling in-band FEC: %w", err)
		}
		// FEC only helps if the decoder is told what to expect.
		if err := enc.SetPacketLossPerc(10); err != nil {
			return nil, fmt.Errorf("setting the expected packet loss: %w", err)
		}
	}

	return &opusEncoder{
		enc:          enc,
		name:         "opus",
		frameSamples: cfg.FrameSamples,
		channels:     cfg.Channels,
		// Generous enough for the largest packet Opus can emit at this frame
		// size; the encoder never writes past what it reports.
		buf: make([]byte, cfg.FrameSamples*cfg.Channels*2+1024),
	}, nil
}

// opusApplication picks the Opus application mode.
//
// The restricted-low-delay mode Sunshine uses is only defined for frame
// durations up to 20 ms. A longer frame is still worth supporting, so it falls
// back to the general audio mode rather than failing.
func opusApplication(cfg Config) (opus.Application, error) {
	switch {
	case cfg.FrameDurationMS() <= 20:
		return opus.AppRestrictedLowdelay, nil
	case cfg.FrameDurationMS() <= 60:
		return opus.AppAudio, nil
	default:
		return 0, fmt.Errorf("frame duration of %.1f ms is too long for Opus, the maximum is 60 ms",
			cfg.FrameDurationMS())
	}
}

func (e *opusEncoder) Name() string { return e.name }

func (e *opusEncoder) Encode(pcm []float32) ([]byte, error) {
	want := e.frameSamples * e.channels
	if len(pcm) != want {
		return nil, fmt.Errorf("opus: got %d samples, want %d", len(pcm), want)
	}
	n, err := e.enc.EncodeFloat32(pcm, e.buf)
	if err != nil {
		return nil, fmt.Errorf("opus: encoding failed: %w", err)
	}
	return e.buf[:n], nil
}

func (e *opusEncoder) Close() error {
	e.enc = nil
	return nil
}
