// SPDX-License-Identifier: BSD-3-Clause

package hub

import "time"

// PaceAhead is how far the sender may run ahead of realtime at 2× before
// dropping to 1.25×. Past the client's play buffer it drops to 0.75× so the
// buffer cannot grow without bound.
const PaceAhead = 5 * time.Millisecond

// SendRate is the packet-rate multiplier for a sender that has already
// delivered sent media after elapsed wall time.
//
// The newest frame is the live edge, not extra, so one frame is excluded from
// the lead. 2× while the extra is under 5 ms, 1.25× until it reaches the play
// buffer, 0.75× beyond that.
func SendRate(frame, sent, elapsed, buffer time.Duration) float64 {
	lead := extraLead(frame, sent, elapsed)
	switch {
	case buffer > 0 && lead >= buffer:
		return 0.75
	case lead >= PaceAhead:
		return 1.25
	default:
		return 2
	}
}

func extraLead(frame, sent, elapsed time.Duration) time.Duration {
	lead := sent - elapsed
	if lead < 0 {
		return 0
	}
	if frame > 0 && lead >= frame {
		lead -= frame
	}
	return lead
}

// SendPacer spaces packet writes against the media clock.
type SendPacer struct {
	Frame  time.Duration
	Buffer time.Duration
	start  time.Time
	sent   time.Duration
}

// Extra is how far the sender is ahead of realtime, excluding the live edge.
func (p *SendPacer) Extra(now time.Time) time.Duration {
	if p.start.IsZero() {
		return 0
	}
	return extraLead(p.Frame, p.sent, now.Sub(p.start))
}

// ObserveSend records that a packet went out and returns how long to wait
// before the next one.
func (p *SendPacer) ObserveSend(now time.Time) time.Duration {
	if p.Frame <= 0 {
		return 0
	}
	if p.start.IsZero() {
		p.start = now
	}
	p.sent += p.Frame
	rate := SendRate(p.Frame, p.sent, now.Sub(p.start), p.Buffer)
	return time.Duration(float64(p.Frame) / rate)
}

// Reset forgets the lead so the next burst starts at 2× again.
func (p *SendPacer) Reset() {
	p.start = time.Time{}
	p.sent = 0
}
