// SPDX-License-Identifier: BSD-3-Clause

package codec

import (
	"encoding/binary"
	"math"
)

func init() {
	Register("pcm_f32le", func(cfg Config) (Encoder, error) {
		return newPCM("pcm_f32le", cfg, 4), nil
	})
	Register("pcm_s16le", func(cfg Config) (Encoder, error) {
		return newPCM("pcm_s16le", cfg, 2), nil
	})
}

// pcmEncoder passes audio through uncompressed.
//
// It exists so a client can receive raw samples without a decoder, which makes
// it the useful codec for debugging: a payload is exactly
// FrameSamples*Channels*bytesPerSample long, so any framing bug shows up as a
// wrong length rather than as noise.
type pcmEncoder struct {
	name           string
	bytesPerSample int
	buf            []byte
}

func newPCM(name string, cfg Config, bytesPerSample int) *pcmEncoder {
	return &pcmEncoder{
		name:           name,
		bytesPerSample: bytesPerSample,
		buf:            make([]byte, cfg.FrameSamples*cfg.Channels*bytesPerSample),
	}
}

func (e *pcmEncoder) Name() string { return e.name }

func (e *pcmEncoder) Encode(pcm []float32) ([]byte, error) {
	switch e.bytesPerSample {
	case 4:
		for i, sample := range pcm {
			// math.Float32bits keeps this identical on any endianness, which
			// is what the "le" in the name promises.
			binary.LittleEndian.PutUint32(e.buf[i*4:], math.Float32bits(sample))
		}
	case 2:
		for i, sample := range pcm {
			binary.LittleEndian.PutUint16(e.buf[i*2:], uint16(floatToInt16(sample)))
		}
	}
	return e.buf, nil
}

func (e *pcmEncoder) Close() error { return nil }

// floatToInt16 converts a float sample to 16 bits, clamping rather than
// wrapping: a value outside [-1, 1] should saturate, not turn into noise of the
// opposite sign.
func floatToInt16(sample float32) int16 {
	if math.IsNaN(float64(sample)) {
		return 0
	}
	if sample >= 1 {
		return math.MaxInt16
	}
	if sample <= -1 {
		return math.MinInt16
	}
	// 32767 rather than 32768 keeps the mapping symmetric about zero.
	return int16(sample * 32767)
}
