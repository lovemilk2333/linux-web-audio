// SPDX-License-Identifier: BSD-3-Clause

package hub

import (
	"testing"
	"time"
)

func TestSendRateStartsAtDouble(t *testing.T) {
	frame := 5 * time.Millisecond
	if got := SendRate(frame, 0, 0, 20*time.Millisecond); got != 2 {
		t.Fatalf("rate at start = %g, want 2", got)
	}
	// One frame out at t=0 is the live edge, not extra.
	if got := SendRate(frame, frame, 0, 20*time.Millisecond); got != 2 {
		t.Fatalf("rate after one frame = %g, want 2", got)
	}
}

func TestSendRateDropsAfterFiveMsLead(t *testing.T) {
	frame := 5 * time.Millisecond
	// sent=15ms, elapsed=5ms → extra = 15-5-5 = 5ms → 1.25×.
	if got := SendRate(frame, 3*frame, frame, 20*time.Millisecond); got != 1.25 {
		t.Fatalf("rate at 5 ms extra = %g, want 1.25 (lead %s)",
			got, extraLead(frame, 3*frame, frame))
	}
}

func TestSendRateDropsPastBuffer(t *testing.T) {
	frame := 5 * time.Millisecond
	buffer := 20 * time.Millisecond
	// sent=30ms, elapsed=5ms → raw 25ms − 5ms = 20ms extra → 0.75×.
	if got := SendRate(frame, 6*frame, frame, buffer); got != 0.75 {
		t.Fatalf("rate at buffer lead = %g, want 0.75 (lead %s)",
			got, extraLead(frame, 6*frame, frame))
	}
}

func TestSendPacerFirstIntervalIsHalfFrame(t *testing.T) {
	p := SendPacer{Frame: 5 * time.Millisecond, Buffer: 20 * time.Millisecond}
	now := time.Unix(0, 0)
	wait := p.ObserveSend(now)
	// First packet, extra 0, 2× → half a frame.
	if wait != 2500*time.Microsecond {
		t.Fatalf("first wait = %s, want 2.5ms", wait)
	}
	if extra := p.Extra(now); extra != 0 {
		t.Fatalf("extra after first send at t=0 = %s, want 0", extra)
	}
}
