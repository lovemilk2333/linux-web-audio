// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"context"
	"io"
	"sync"
	"sync/atomic"

	"github.com/lovemilk2333/linux-web-audio/internal/proto"
)

// Packet is one encoded packet ready to be framed and sent.
type Packet struct {
	Seq       uint16
	Timestamp uint32
	Flags     uint8
	Payload   []byte
}

// Subscriber is one listener's view of the stream.
//
// Next is the single consumption point and must be called from one goroutine
// only; everything the hub does to a subscriber is safe to call concurrently.
type Subscriber struct {
	codec  string
	ch     chan Packet
	policy SlowPolicy
	hub    *Hub

	// catchup holds history packets to replay before the live stream. It is
	// fixed at construction, so no lock is needed to read it.
	catchup []Packet

	closeOnce sync.Once
	closed    chan struct{}

	// pending carries flags to attach to the next packet delivered.
	pending atomic.Uint32
	dropped atomic.Uint64
	sent    atomic.Uint64

	// Catch-up cursor and duplicate suppression, owned by the Next caller.
	catchupIndex int
	lastSent     uint16
	haveSent     bool
}

// Codec returns the codec this subscriber is receiving.
func (s *Subscriber) Codec() string { return s.codec }

// Dropped reports how many packets were discarded because the subscriber fell
// behind.
func (s *Subscriber) Dropped() uint64 { return s.dropped.Load() }

// Sent reports how many packets have been handed out by Next.
func (s *Subscriber) Sent() uint64 { return s.sent.Load() }

// Closed reports whether the subscriber has been closed.
func (s *Subscriber) Closed() bool {
	select {
	case <-s.closed:
		return true
	default:
		return false
	}
}

// Next returns the next packet to send, replaying the catch-up backlog first.
//
// It returns io.EOF once the subscriber is closed and the backlog is drained,
// and ctx.Err() if the context is cancelled first.
func (s *Subscriber) Next(ctx context.Context) (Packet, error) {
	for s.catchupIndex < len(s.catchup) {
		pkt := s.catchup[s.catchupIndex]
		s.catchupIndex++
		if s.alreadySent(pkt.Seq) {
			continue
		}
		s.record(pkt.Seq)
		return pkt, nil
	}

	for {
		/* Anything already queued is delivered before a close is honoured, so a
		 * subscriber that was cut off still receives what was accepted for it.
		 * Checking without blocking first also makes that order deterministic:
		 * a select with both cases ready would choose between them at random. */
		select {
		case pkt, ok := <-s.ch:
			if !ok {
				return Packet{}, io.EOF
			}
			if s.alreadySent(pkt.Seq) {
				// Already delivered while replaying history.
				continue
			}
			s.record(pkt.Seq)
			return pkt, nil
		default:
		}

		select {
		case <-ctx.Done():
			return Packet{}, ctx.Err()
		case <-s.closed:
			// The queue was drained above, so there is nothing left.
			return Packet{}, io.EOF
		case pkt, ok := <-s.ch:
			if !ok {
				return Packet{}, io.EOF
			}
			if s.alreadySent(pkt.Seq) {
				continue
			}
			s.record(pkt.Seq)
			return pkt, nil
		}
	}
}

func (s *Subscriber) alreadySent(seq uint16) bool {
	return s.haveSent && proto.SeqDiff(s.lastSent, seq) <= 0
}

func (s *Subscriber) record(seq uint16) {
	s.lastSent = seq
	s.haveSent = true
	s.sent.Add(1)
}

// push queues a packet, applying the overflow policy when the queue is full.
//
// Called by the hub while it holds its lock, so it must never block and must
// never call back into the hub: unsubscribe() takes the same lock and would
// deadlock.
func (s *Subscriber) push(pkt Packet) {
	// Anything owed from an earlier drop belongs to this packet, which is the
	// first one the subscriber will see after that gap.
	pkt.Flags |= s.takePendingFlags()

	select {
	case s.ch <- pkt:
		return
	default:
	}

	switch s.policy {
	case Disconnect:
		s.dropped.Add(1)
		s.signalClosed()

	case DropNewest:
		// Keep what is queued and discard the newcomer. The gap is owed to
		// whichever packet does make it through later.
		s.dropped.Add(1)
		s.markDiscontinuity()

	default: // FastForward
		// Throw the backlog away and deliver the newest packet, so a slow
		// client's latency stays bounded instead of growing without limit.
		var discarded uint64
		for {
			select {
			case <-s.ch:
				discarded++
				continue
			default:
			}
			break
		}
		s.dropped.Add(discarded)

		// This packet begins the new contiguous run, so it carries the flag
		// rather than the one after it.
		pkt.Flags |= uint8(proto.FlagDiscontinuity)

		select {
		case s.ch <- pkt:
		default:
			// The consumer refilled the queue between the drain and here.
			s.dropped.Add(1)
			s.markDiscontinuity()
		}
	}
}

func (s *Subscriber) markDiscontinuity() {
	s.pending.Or(uint32(proto.FlagDiscontinuity))
}

// takePendingFlags returns and clears the flags owed to the next packet.
func (s *Subscriber) takePendingFlags() uint8 {
	return uint8(s.pending.Swap(0))
}

// signalClosed wakes any waiter without touching the hub, so it is safe to call
// from inside a hub lock. Idempotent.
func (s *Subscriber) signalClosed() {
	s.closeOnce.Do(func() { close(s.closed) })
}

// Close releases the subscriber and any codec it was the last user of.
// Idempotent and safe to call concurrently.
func (s *Subscriber) Close() {
	s.signalClosed()
	s.hub.unsubscribe(s)
}
