// SPDX-License-Identifier: BSD-3-Clause

package hub

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"slices"
	"testing"
	"time"

	"github.com/lovemilk2333/linux-web-audio/internal/proto"
)

const (
	testRate     = 48000
	testChannels = 2
	testFrame    = 960 // 20 ms
)

// testSource feeds frames on demand.
type testSource struct {
	ch     chan Frame
	closed bool
}

func newTestSource() *testSource {
	// Deep enough that a test can push a burst without the hub's consumer
	// being scheduled in between.
	return &testSource{ch: make(chan Frame, 4096)}
}

func (s *testSource) Frames() <-chan Frame { return s.ch }

func (s *testSource) Close() error {
	if !s.closed {
		s.closed = true
		close(s.ch)
	}
	return nil
}

// send pushes n frames of a 440 Hz tone, each tagged with flags.
func (s *testSource) send(n int, flags uint8) {
	for f := range n {
		pcm := make([]float32, testFrame*testChannels)
		for i := range testFrame {
			v := float32(0.25 * math.Sin(2*math.Pi*440*float64(f*testFrame+i)/testRate))
			for c := range testChannels {
				pcm[i*testChannels+c] = v
			}
		}
		s.ch <- Frame{PCM: pcm, Flags: flags, Timestamp: time.Now()}
	}
}

func testConfig() Config {
	return Config{
		Codec:          "opus",
		SampleRate:     testRate,
		Channels:       testChannels,
		FrameSamples:   testFrame,
		Bitrate:        96000,
		HistoryPackets: 100,
		ClientQueue:    64,
		SlowClient:     FastForward,
	}
}

func startHub(t *testing.T, cfg Config) (*Hub, *testSource) {
	t.Helper()

	h, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	src := newTestSource()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = h.Run(ctx, src)
	}()

	t.Cleanup(func() {
		cancel()
		_ = src.Close()
		<-done
	})
	return h, src
}

func next(t *testing.T, sub *Subscriber, timeout time.Duration) (Packet, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return sub.Next(ctx)
}

func mustNext(t *testing.T, sub *Subscriber) Packet {
	t.Helper()
	pkt, err := next(t, sub, 5*time.Second)
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	return pkt
}

func TestLiveStreamIsContiguous(t *testing.T) {
	h, src := startHub(t, testConfig())

	sub, err := h.Subscribe("opus", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Close()

	const frames = 20
	src.send(frames, 0)

	prev := mustNext(t, sub)
	if prev.Flags&proto.FlagDiscontinuity != 0 {
		t.Errorf("the first packet should not be flagged discontinuous: %v", proto.FlagsString(prev.Flags))
	}
	if len(prev.Payload) == 0 {
		t.Error("the first packet has an empty payload")
	}

	for i := 1; i < frames; i++ {
		pkt := mustNext(t, sub)

		if got := proto.SeqDistance(prev.Seq, pkt.Seq); got != 1 {
			t.Fatalf("packet %d: seq jumped by %d (%d -> %d), want exactly 1",
				i, got, prev.Seq, pkt.Seq)
		}
		if want := prev.Timestamp + testFrame; pkt.Timestamp != want {
			t.Fatalf("packet %d: timestamp = %d, want %d", i, pkt.Timestamp, want)
		}
		if pkt.Flags&proto.FlagDiscontinuity != 0 {
			t.Fatalf("packet %d was flagged discontinuous on a healthy stream", i)
		}
		prev = pkt
	}
}

// Frames captured while nobody was listening must not be replayed to a client
// that joins live: it should start at the current edge.
func TestLiveJoinStartsAtTheEdge(t *testing.T) {
	h, src := startHub(t, testConfig())

	src.send(10, 0)
	// Give the hub a moment to consume them with no subscribers.
	time.Sleep(50 * time.Millisecond)

	sub, err := h.Subscribe("opus", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Close()

	src.send(1, 0)
	pkt := mustNext(t, sub)

	if pkt.Flags&proto.FlagCatchup != 0 {
		t.Error("a live subscriber was served a replayed packet")
	}
	if pkt.Flags&proto.FlagDiscontinuity != 0 {
		t.Error("a live subscriber should not be flagged discontinuous on its first packet")
	}
}

// The core resume scenario: disconnect, reconnect with the next expected
// sequence number, and get the missed packets replayed with no gap.
func TestResumeFromSequenceNumber(t *testing.T) {
	h, src := startHub(t, testConfig())

	first, err := h.Subscribe("opus", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}

	src.send(5, 0)
	var last Packet
	for range 5 {
		last = mustNext(t, first)
	}
	first.Close()

	// Audio continues while the client is away.
	src.send(5, 0)
	time.Sleep(50 * time.Millisecond)

	resumeFrom := last.Seq + 1
	second, err := h.Subscribe("opus", &resumeFrom)
	if err != nil {
		t.Fatalf("Subscribe with a resume point: %v", err)
	}
	defer second.Close()

	// The replayed five packets, then the live stream, in one contiguous run.
	for i := range 5 {
		pkt := mustNext(t, second)
		if pkt.Flags&proto.FlagCatchup == 0 {
			t.Errorf("replayed packet %d is missing the catch-up flag", i)
		}
		if want := resumeFrom + uint16(i); pkt.Seq != want {
			t.Errorf("replayed packet %d: seq = %d, want %d", i, pkt.Seq, want)
		}
	}

	src.send(3, 0)
	want := resumeFrom + 5
	for i := range 3 {
		pkt := mustNext(t, second)
		if pkt.Seq != want+uint16(i) {
			t.Fatalf("live packet %d: seq = %d, want %d (a gap after the replay)",
				i, pkt.Seq, want+uint16(i))
		}
		if pkt.Flags&proto.FlagCatchup != 0 {
			t.Errorf("live packet %d is flagged as a replay", i)
		}
	}
}

func TestResumeOutsideWindowIsRejected(t *testing.T) {
	cfg := testConfig()
	cfg.HistoryPackets = 8
	h, src := startHub(t, cfg)

	sub, err := h.Subscribe("opus", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Close()

	src.send(40, 0)
	for range 40 {
		mustNext(t, sub)
	}

	// Far enough back that it has certainly been overwritten.
	stale := uint16(0)
	if _, err := h.Subscribe("opus", &stale); !errors.Is(err, ErrSeqOutOfRange) {
		t.Fatalf("subscribing to an overwritten sequence number gave %v, want ErrSeqOutOfRange", err)
	}

	// A sequence number that has not been produced yet is out of range too.
	future := h.Stats().CurrentSeq + 10
	if _, err := h.Subscribe("opus", &future); !errors.Is(err, ErrSeqOutOfRange) {
		t.Fatalf("subscribing ahead of the stream gave %v, want ErrSeqOutOfRange", err)
	}
}

// Recording continues while nobody is listening, because the hub keeps a
// reference to the default codec's encoder. That is what lets a client that was
// the only listener reconnect and resume without a hole.
func TestResumeWorksAfterTheLastSubscriberLeaves(t *testing.T) {
	h, src := startHub(t, testConfig())

	sub, err := h.Subscribe("opus", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	src.send(5, 0)
	var last Packet
	for range 5 {
		last = mustNext(t, sub)
	}
	sub.Close()

	if got := h.Stats().Subscribers; got != 0 {
		t.Fatalf("subscribers = %d after closing the only one, want 0", got)
	}

	// Ten seconds of audio with nobody connected.
	src.send(5, 0)
	time.Sleep(50 * time.Millisecond)

	resumeFrom := last.Seq + 1
	revived, err := h.Subscribe("opus", &resumeFrom)
	if err != nil {
		t.Fatalf("resuming after the last subscriber left: %v", err)
	}
	defer revived.Close()

	for i := range 5 {
		pkt := mustNext(t, revived)
		if want := resumeFrom + uint16(i); pkt.Seq != want {
			t.Fatalf("replayed packet %d: seq = %d, want %d", i, pkt.Seq, want)
		}
		if pkt.Flags&proto.FlagCatchup == 0 {
			t.Errorf("packet %d, produced while nobody was listening, should be flagged as a replay", i)
		}
	}
}

func TestMultipleCodecsAreIndependent(t *testing.T) {
	h, src := startHub(t, testConfig())

	opusSub, err := h.Subscribe("opus", nil)
	if err != nil {
		t.Fatalf("Subscribe(opus): %v", err)
	}
	defer opusSub.Close()

	pcmSub, err := h.Subscribe("pcm_s16le", nil)
	if err != nil {
		t.Fatalf("Subscribe(pcm_s16le): %v", err)
	}
	defer pcmSub.Close()

	src.send(3, 0)

	opusPkt := mustNext(t, opusSub)
	pcmPkt := mustNext(t, pcmSub)

	if opusPkt.Seq != pcmPkt.Seq {
		t.Errorf("codecs disagree on the sequence number: %d vs %d", opusPkt.Seq, pcmPkt.Seq)
	}
	if opusPkt.Timestamp != pcmPkt.Timestamp {
		t.Errorf("codecs disagree on the timestamp: %d vs %d", opusPkt.Timestamp, pcmPkt.Timestamp)
	}

	// PCM has a known payload size, which proves the right encoder was used.
	if want := testFrame * testChannels * 2; len(pcmPkt.Payload) != want {
		t.Errorf("pcm_s16le payload = %d bytes, want %d", len(pcmPkt.Payload), want)
	}
	if len(opusPkt.Payload) == testFrame*testChannels*2 {
		t.Error("the opus subscriber received an uncompressed payload")
	}

	encoders := h.Stats().Encoders
	if len(encoders) != 2 {
		t.Errorf("active encoders = %v, want opus and pcm_s16le", encoders)
	}
}

func TestEncoderIsReleasedWithItsLastSubscriber(t *testing.T) {
	h, src := startHub(t, testConfig())
	_ = src

	// The default codec is always active; a non-default one is not.
	hasCodec := func(name string) bool {
		return slices.Contains(h.Stats().Encoders, name)
	}

	if hasCodec("pcm_f32le") {
		t.Fatal("a codec with no subscribers was active")
	}

	sub, err := h.Subscribe("pcm_f32le", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	if !hasCodec("pcm_f32le") {
		t.Fatal("the codec was not enabled for its first subscriber")
	}

	other, err := h.Subscribe("pcm_f32le", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	sub.Close()
	if !hasCodec("pcm_f32le") {
		t.Error("the codec was released while a subscriber still wanted it")
	}

	other.Close()
	if hasCodec("pcm_f32le") {
		t.Error("the codec was not released with its last subscriber")
	}

	// The default codec survives having no subscribers at all.
	if !hasCodec("opus") {
		t.Error("the default codec was released, which would break resuming")
	}
}

func TestUnknownCodecIsRejected(t *testing.T) {
	h, _ := startHub(t, testConfig())
	if _, err := h.Subscribe("nosuchcodec", nil); err == nil {
		t.Error("Subscribe accepted an unknown codec")
	}
}

// A subscriber that stops reading must not stall the hub, and must be told its
// stream has a gap rather than silently missing audio.
func TestSlowSubscriberFastForwards(t *testing.T) {
	cfg := testConfig()
	cfg.ClientQueue = 4
	cfg.SlowClient = FastForward
	h, src := startHub(t, cfg)

	sub, err := h.Subscribe("pcm_s16le", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Close()

	// Never read, so the queue overflows repeatedly.
	src.send(50, 0)
	time.Sleep(100 * time.Millisecond)

	pkt := mustNext(t, sub)
	if pkt.Flags&proto.FlagDiscontinuity == 0 {
		t.Error("a subscriber that fell behind was not told its stream has a gap")
	}
	if got := sub.Dropped(); got == 0 {
		t.Error("no packets were reported as dropped")
	}
	if got := sub.Dropped(); got > 50 {
		t.Errorf("dropped %d packets out of 50 produced", got)
	}

	// The hub must still be serving everyone properly afterwards.
	src.send(1, 0)
	next2 := mustNext(t, sub)
	if proto.SeqDiff(pkt.Seq, next2.Seq) <= 0 {
		t.Errorf("the stream did not advance after fast-forwarding: %d then %d", pkt.Seq, next2.Seq)
	}
}

func TestDisconnectPolicyClosesTheSubscriber(t *testing.T) {
	cfg := testConfig()
	cfg.ClientQueue = 2
	cfg.SlowClient = Disconnect
	h, src := startHub(t, cfg)

	sub, err := h.Subscribe("pcm_s16le", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Close()

	src.send(50, 0)
	time.Sleep(100 * time.Millisecond)

	if !sub.Closed() {
		t.Fatal("the subscriber was not closed after overflowing")
	}

	// Whatever was already queued is still delivered, then the stream ends:
	// the close is a cut-off, not a discard of data already accepted.
	delivered := 0
	for {
		_, err := next(t, sub, 2*time.Second)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("Next gave %v, want a packet or io.EOF", err)
		}
		delivered++
		if delivered > cfg.ClientQueue {
			t.Fatalf("delivered %d packets from a queue of %d", delivered, cfg.ClientQueue)
		}
	}
	if delivered == 0 {
		t.Error("no buffered packet was delivered before the stream ended")
	}
}

func TestCloseDuringReadReturnsEOF(t *testing.T) {
	h, _ := startHub(t, testConfig())

	sub, err := h.Subscribe("opus", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := next(t, sub, 5*time.Second)
		done <- err
	}()

	time.Sleep(20 * time.Millisecond)
	sub.Close()

	if err := <-done; !errors.Is(err, io.EOF) {
		t.Errorf("a blocked Next returned %v after Close, want io.EOF", err)
	}
}

// Close is called both by the handler and, under the disconnect policy, from
// inside the hub's own lock, so it has to be safe to call repeatedly.
func TestCloseIsIdempotent(t *testing.T) {
	h, _ := startHub(t, testConfig())

	sub, err := h.Subscribe("opus", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	sub.Close()
	sub.Close()
	sub.Close()

	if got := h.Stats().Subscribers; got != 0 {
		t.Errorf("subscribers = %d after closing, want 0", got)
	}
}

// The sequence number is 16 bits and the stream is meant to run for days, so
// the wrap has to be invisible.
func TestSequenceWrapsCleanly(t *testing.T) {
	h, src := startHub(t, testConfig())

	// Start just before the wrap.
	h.mu.Lock()
	h.nextSeq = 65533
	h.mu.Unlock()

	sub, err := h.Subscribe("pcm_s16le", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Close()

	const frames = 8
	src.send(frames, 0)

	prev := mustNext(t, sub)
	seqs := []uint16{prev.Seq}
	for range frames - 1 {
		pkt := mustNext(t, sub)
		if got := proto.SeqDistance(prev.Seq, pkt.Seq); got != 1 {
			t.Fatalf("seq jumped by %d across the wrap (%d -> %d)", got, prev.Seq, pkt.Seq)
		}
		seqs = append(seqs, pkt.Seq)
		prev = pkt
	}

	t.Logf("sequence numbers across the wrap: %v", seqs)

	want := []uint16{65533, 65534, 65535, 0, 1, 2, 3, 4}
	for i := range want {
		if seqs[i] != want[i] {
			t.Errorf("seq[%d] = %d, want %d", i, seqs[i], want[i])
		}
	}
}

func TestFlagsAreCarriedThrough(t *testing.T) {
	h, src := startHub(t, testConfig())

	sub, err := h.Subscribe("pcm_s16le", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Close()

	src.send(1, proto.FlagSilence|proto.FlagUnderrun)
	pkt := mustNext(t, sub)

	if pkt.Flags&proto.FlagSilence == 0 {
		t.Error("the silence flag from the capture layer was lost")
	}
	if pkt.Flags&proto.FlagUnderrun == 0 {
		t.Error("the underrun flag from the capture layer was lost")
	}
}

func TestStatsReportTheStreamShape(t *testing.T) {
	h, src := startHub(t, testConfig())

	stats := h.Stats()
	if stats.Codec != "opus" {
		t.Errorf("Codec = %q, want opus", stats.Codec)
	}
	if stats.SampleRate != testRate || stats.Channels != testChannels || stats.FrameSamples != testFrame {
		t.Errorf("format = %d Hz / %d ch / %d frames, want %d / %d / %d",
			stats.SampleRate, stats.Channels, stats.FrameSamples, testRate, testChannels, testFrame)
	}
	if stats.FrameDurationMS != 20 {
		t.Errorf("FrameDurationMS = %v, want 20", stats.FrameDurationMS)
	}
	if stats.Started {
		t.Error("the hub reported itself started before any frame arrived")
	}

	sub, err := h.Subscribe("opus", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Close()

	src.send(3, 0)
	mustNext(t, sub)

	stats = h.Stats()
	if !stats.Started {
		t.Error("the hub did not report itself started after producing packets")
	}
	if stats.Subscribers != 1 {
		t.Errorf("Subscribers = %d, want 1", stats.Subscribers)
	}
	if stats.Frames == 0 {
		t.Error("Frames = 0 after producing packets")
	}
	if stats.OldestSeq != 0 {
		t.Errorf("OldestSeq = %d, want 0", stats.OldestSeq)
	}
	if stats.CurrentSeq != 2 {
		t.Errorf("CurrentSeq = %d, want 2 after three packets", stats.CurrentSeq)
	}
}

func TestRecentReturnsNewestPackets(t *testing.T) {
	h, src := startHub(t, testConfig())

	sub, err := h.Subscribe("opus", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Close()

	src.send(10, 0)
	for range 10 {
		mustNext(t, sub)
	}
	time.Sleep(20 * time.Millisecond)

	got := h.Recent("opus", 3)
	if len(got) != 3 {
		t.Fatalf("Recent returned %d packets, want 3", len(got))
	}
	if got[0].Seq+2 != got[2].Seq {
		t.Errorf("Recent packets were not contiguous: %d, %d, %d", got[0].Seq, got[1].Seq, got[2].Seq)
	}
	if got[2].Seq != h.Stats().CurrentSeq {
		t.Errorf("newest Recent seq = %d, want current %d", got[2].Seq, h.Stats().CurrentSeq)
	}
	for i, pkt := range got {
		if pkt.Flags&proto.FlagCatchup == 0 {
			t.Errorf("Recent packet %d is missing the catch-up flag", i)
		}
	}
}

func TestPrefillReplaysAfterAlreadySent(t *testing.T) {
	h, src := startHub(t, testConfig())

	sub, err := h.Subscribe("opus", nil)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Close()

	src.send(5, 0)
	var last Packet
	for range 5 {
		last = mustNext(t, sub)
	}
	time.Sleep(20 * time.Millisecond)

	// Without clearing alreadySent, Prefill of overlapping history would
	// be skipped and the play buffer would stay empty after a jump.
	sub.Prefill(h.Recent("opus", 3))
	if sub.Backlog() < 3 {
		t.Fatalf("Backlog after Prefill = %d, want at least 3", sub.Backlog())
	}

	first := mustNext(t, sub)
	if first.Flags&proto.FlagCatchup == 0 {
		t.Error("prefilled packet is missing the catch-up flag")
	}
	if proto.SeqDiff(first.Seq, last.Seq) < 0 {
		t.Errorf("prefilled seq %d is ahead of last live %d", first.Seq, last.Seq)
	}
}

func TestParseSlowPolicy(t *testing.T) {
	for name, want := range map[string]SlowPolicy{
		"fast-forward": FastForward,
		"drop":         DropNewest,
		"disconnect":   Disconnect,
	} {
		got, err := ParseSlowPolicy(name)
		if err != nil {
			t.Errorf("ParseSlowPolicy(%q): %v", name, err)
		}
		if got != want {
			t.Errorf("ParseSlowPolicy(%q) = %v, want %v", name, got, want)
		}
	}
	if _, err := ParseSlowPolicy("nonsense"); err == nil {
		t.Error("ParseSlowPolicy accepted an unknown policy")
	}
}

func TestConfigValidate(t *testing.T) {
	bad := []Config{
		{Codec: "", SampleRate: testRate, Channels: 2, FrameSamples: testFrame, ClientQueue: 1},
		{Codec: "nosuch", SampleRate: testRate, Channels: 2, FrameSamples: testFrame, ClientQueue: 1},
		{Codec: "opus", SampleRate: testRate, Channels: 2, FrameSamples: testFrame, ClientQueue: 0},
		{Codec: "opus", SampleRate: 0, Channels: 2, FrameSamples: testFrame, ClientQueue: 1},
		{Codec: "opus", SampleRate: testRate, Channels: 2, FrameSamples: testFrame, ClientQueue: 1, HistoryPackets: -1},
	}
	for i, cfg := range bad {
		if err := cfg.Validate(); err == nil {
			t.Errorf("configuration %d was accepted but should not be: %+v", i, cfg)
		}
	}
	if err := testConfig().Validate(); err != nil {
		t.Errorf("the test configuration should be valid: %v", err)
	}
}

func TestHistoryRingKeepsTheNewest(t *testing.T) {
	h := newHistory(4)
	for i := range 10 {
		h.append(historyEntry{seq: uint16(i), timestamp: uint32(i * 100)})
	}

	oldest, latest, ok := h.bounds()
	if !ok {
		t.Fatal("bounds reported empty after appending")
	}
	if oldest != 6 || latest != 9 {
		t.Errorf("bounds = %d..%d, want 6..9", oldest, latest)
	}

	out := h.replay("opus", 6, 9)
	if len(out) != 0 {
		t.Errorf("replay returned %d entries for a codec that was never stored", len(out))
	}

	h2 := newHistory(4)
	h2.append(historyEntry{seq: 7, payloads: []payloadRef{{codec: "opus", data: []byte{1}}}})
	h2.append(historyEntry{seq: 8, payloads: []payloadRef{{codec: "pcm_s16le", data: []byte{2}}}})
	h2.append(historyEntry{seq: 9, payloads: []payloadRef{{codec: "opus", data: []byte{3}}}})

	opusOnly := h2.replay("opus", 7, 9)
	if len(opusOnly) != 2 {
		t.Fatalf("replay(opus) returned %d entries, want 2", len(opusOnly))
	}
	if opusOnly[0].Seq != 7 || opusOnly[1].Seq != 9 {
		t.Errorf("replay(opus) seqs = %d,%d, want 7,9", opusOnly[0].Seq, opusOnly[1].Seq)
	}
	for _, pkt := range opusOnly {
		if pkt.Flags&proto.FlagCatchup == 0 {
			t.Error("replayed packets should carry the catch-up flag")
		}
	}
}

func TestHistoryReplayHandlesWraparound(t *testing.T) {
	h := newHistory(8)
	for _, seq := range []uint16{65533, 65534, 65535, 0, 1, 2} {
		h.append(historyEntry{seq: seq, payloads: []payloadRef{{codec: "opus", data: []byte{byte(seq)}}}})
	}

	out := h.replay("opus", 65535, 2)
	if len(out) != 4 {
		t.Fatalf("replay across the wrap returned %d entries, want 4", len(out))
	}
	want := []uint16{65535, 0, 1, 2}
	for i, seq := range want {
		if out[i].Seq != seq {
			t.Errorf("out[%d].Seq = %d, want %d", i, out[i].Seq, seq)
		}
	}
}
