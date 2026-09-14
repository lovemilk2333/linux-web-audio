// SPDX-License-Identifier: BSD-3-Clause

package codec

import (
	"math"
	"strings"
	"testing"

	"github.com/hraban/opus"
)

func testConfig() Config {
	return Config{SampleRate: 48000, Channels: 2, FrameSamples: 960}
}

func TestRegistryIsPopulated(t *testing.T) {
	names := Names()
	if len(names) < 3 {
		t.Fatalf("registered codecs = %v, want at least opus and the two PCM formats", names)
	}
	for _, want := range []string{"opus", "pcm_f32le", "pcm_s16le"} {
		if _, ok := Lookup(want); !ok {
			t.Errorf("codec %q is not registered", want)
		}
	}
}

func TestParseList(t *testing.T) {
	got, err := ParseList("opus, pcm_s16le ,opus")
	if err != nil {
		t.Fatalf("ParseList: %v", err)
	}
	if len(got) != 2 || got[0] != "opus" || got[1] != "pcm_s16le" {
		t.Errorf("ParseList = %v, want [opus pcm_s16le] with the duplicate removed", got)
	}

	if _, err := ParseList("nosuchcodec"); err == nil {
		t.Error("ParseList accepted an unknown codec")
	} else if !strings.Contains(err.Error(), "opus") {
		t.Errorf("the error should list the supported codecs, got: %v", err)
	}

	if _, err := ParseList("  "); err == nil {
		t.Error("ParseList accepted an empty list")
	}
}

// A PCM payload has a known length, which makes it the codec that catches
// framing mistakes.
func TestPCMS16PayloadLength(t *testing.T) {
	cfg := testConfig()
	enc, err := New("pcm_s16le", cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer enc.Close()

	pcm := make([]float32, cfg.FrameSamples*cfg.Channels)
	payload, err := enc.Encode(pcm)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if want := cfg.FrameSamples * cfg.Channels * 2; len(payload) != want {
		t.Errorf("payload length = %d, want %d", len(payload), want)
	}
}

func TestPCMFloat32RoundTrip(t *testing.T) {
	cfg := testConfig()
	enc, err := New("pcm_f32le", cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer enc.Close()

	pcm := make([]float32, cfg.FrameSamples*cfg.Channels)
	for i := range pcm {
		pcm[i] = float32(i%1000)/1000*2 - 1
	}

	payload, err := enc.Encode(pcm)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if want := len(pcm) * 4; len(payload) != want {
		t.Fatalf("payload length = %d, want %d", len(payload), want)
	}

	for i := range pcm {
		bits := uint32(payload[i*4]) | uint32(payload[i*4+1])<<8 |
			uint32(payload[i*4+2])<<16 | uint32(payload[i*4+3])<<24
		if got := math.Float32frombits(bits); got != pcm[i] {
			t.Fatalf("sample %d = %v, want %v", i, got, pcm[i])
		}
	}
}

// Out-of-range samples must saturate instead of wrapping to the opposite sign.
func TestPCMClamping(t *testing.T) {
	if got := floatToInt16(2.0); got != math.MaxInt16 {
		t.Errorf("floatToInt16(2.0) = %d, want %d", got, math.MaxInt16)
	}
	if got := floatToInt16(-2.0); got != math.MinInt16 {
		t.Errorf("floatToInt16(-2.0) = %d, want %d", got, math.MinInt16)
	}
	if got := floatToInt16(0); got != 0 {
		t.Errorf("floatToInt16(0) = %d, want 0", got)
	}
}

// Opus is a lossy codec with lookahead, so the decoded signal is delayed
// relative to the input. The honest test is therefore "faithful up to a
// constant delay", not sample-exact alignment.
func TestOpusEncodeProducesPayload(t *testing.T) {
	const frames = 4
	cfg := testConfig()
	cfg.Bitrate = 96000

	enc, err := New("opus", cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer enc.Close()

	dec, err := opus.NewDecoder(cfg.SampleRate, cfg.Channels)
	if err != nil {
		t.Fatalf("decoder: %v", err)
	}

	// A continuing 440 Hz tone across several frames.
	samples := func(i int) float32 {
		return float32(0.5 * math.Sin(2*math.Pi*440*float64(i)/float64(cfg.SampleRate)))
	}

	pcm := make([]float32, frames*cfg.FrameSamples*cfg.Channels)
	for i := range pcm {
		pcm[i] = samples(i / cfg.Channels)
	}

	decoded := make([]float32, 0, len(pcm))
	for f := range frames {
		frame := pcm[f*cfg.FrameSamples*cfg.Channels : (f+1)*cfg.FrameSamples*cfg.Channels]
		payload, err := enc.Encode(frame)
		if err != nil {
			t.Fatalf("Encode: %v", err)
		}
		if len(payload) == 0 {
			t.Fatal("encoder produced an empty payload")
		}
		if len(payload) > 1500 {
			t.Errorf("payload of %d bytes is implausibly large for a 20 ms frame", len(payload))
		}

		out := make([]float32, cfg.FrameSamples*cfg.Channels)
		n, err := dec.DecodeFloat32(payload, out)
		if err != nil {
			t.Fatalf("DecodeFloat32: %v", err)
		}
		if n != cfg.FrameSamples {
			t.Fatalf("decoded %d frames, want %d", n, cfg.FrameSamples)
		}
		decoded = append(decoded, out...)
	}

	// Compare a window in the middle, hunting for the delay that best aligns
	// the two signals.
	const maxLag = 400
	const compareFrames = 960 // one frame's worth

	regionStart := 2 * cfg.FrameSamples
	bestLag, bestSNR := 0, math.Inf(-1)
	for lag := 0; lag <= maxLag; lag++ {
		var signal, noise float64
		for i := regionStart; i < regionStart+compareFrames; i++ {
			want := float64(pcm[(i-lag)*cfg.Channels])
			signal += want * want
			d := want - float64(decoded[i*cfg.Channels])
			noise += d * d
		}
		if signal == 0 {
			t.Fatal("the test signal was silent")
		}
		snr := math.Inf(1)
		if noise > 0 {
			snr = 10 * math.Log10(signal/noise)
		}
		if snr > bestSNR {
			bestSNR, bestLag = snr, lag
		}
	}

	t.Logf("Opus round trip: latency %d samples (%.2f ms), SNR %.1f dB",
		bestLag, float64(bestLag)*1000/float64(cfg.SampleRate), bestSNR)

	if bestSNR < 20 {
		t.Errorf("signal-to-noise ratio = %.1f dB at a delay of %d samples, want at least 20 dB",
			bestSNR, bestLag)
	}
	if bestLag > maxLag {
		t.Errorf("latency of %d samples exceeds the %d sample search window", bestLag, maxLag)
	}
}

func TestOpusRejectsMultichannel(t *testing.T) {
	cfg := testConfig()
	cfg.Channels = 6
	if _, err := New("opus", cfg); err == nil {
		t.Error("Opus accepted 6 channels, which it cannot encode without mapping")
	}
}

// Frame durations beyond 20 ms are outside the restricted-low-delay mode, and
// beyond 60 ms outside Opus entirely.
func TestOpusApplicationSelection(t *testing.T) {
	cfg := testConfig()

	cfg.FrameSamples = 960 // 20 ms
	if app, err := opusApplication(cfg); err != nil || app != opus.AppRestrictedLowdelay {
		t.Errorf("20 ms: app = %v, err = %v; want restricted low delay", app, err)
	}

	cfg.FrameSamples = 2880 // 60 ms
	if app, err := opusApplication(cfg); err != nil || app != opus.AppAudio {
		t.Errorf("60 ms: app = %v, err = %v; want general audio", app, err)
	}

	cfg.FrameSamples = 3840 // 80 ms
	if _, err := opusApplication(cfg); err == nil {
		t.Error("80 ms frames were accepted, but Opus cannot encode them")
	}
}

func TestEncodeRejectsWrongSampleCount(t *testing.T) {
	enc, err := New("opus", testConfig())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer enc.Close()

	if _, err := enc.Encode(make([]float32, 10)); err == nil {
		t.Error("Encode accepted a frame of the wrong length")
	}
}

func TestConfigValidate(t *testing.T) {
	bad := []Config{
		{SampleRate: 0, Channels: 2, FrameSamples: 960},
		{SampleRate: 48000, Channels: 0, FrameSamples: 960},
		{SampleRate: 48000, Channels: 9, FrameSamples: 960},
		{SampleRate: 48000, Channels: 2, FrameSamples: 0},
		{SampleRate: 48000, Channels: 2, FrameSamples: 960, Bitrate: -1},
	}
	for i, cfg := range bad {
		if err := cfg.Validate(); err == nil {
			t.Errorf("configuration %d was accepted but should not be: %+v", i, cfg)
		}
	}
	if err := testConfig().Validate(); err != nil {
		t.Errorf("the default configuration should be valid: %v", err)
	}
}
