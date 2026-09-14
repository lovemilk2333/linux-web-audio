// SPDX-License-Identifier: BSD-3-Clause

// Command webclient is a reference client for the linux-web-audio stream.
//
// It is deliberately a plain HTTP client: fetch /audio/info, open
// /audio/stream, read framed packets, and report what arrived. It also
// exercises the resume path, which is the awkward part of the protocol to get
// right — disconnect, reconnect with ?from_seq, and check that the missed audio
// was actually served rather than skipped.
//
//	webclient -duration 5s
//	webclient -resume-test -duration 6s
//	webclient -codec pcm_s16le -duration 2s
//	webclient -out capture.wav -duration 10s
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/hraban/opus"
	"github.com/lovemilk2333/linux-web-audio/internal/proto"
)

type options struct {
	baseURL     string
	basePath    string
	codec       string
	duration    time.Duration
	fromSeq     int
	token       string
	out         string
	resumeTest  bool
	resumeAfter time.Duration
	verbose     bool
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "webclient: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var opts options
	flag.StringVar(&opts.baseURL, "url", "http://127.0.0.1:8642", "server base URL")
	flag.StringVar(&opts.basePath, "base-path", "/backend",
		"the server's --base-path, prepended to every endpoint")
	flag.StringVar(&opts.codec, "codec", "", "codec to request; empty uses the server's default")
	flag.DurationVar(&opts.duration, "duration", 5*time.Second, "how long to listen")
	flag.IntVar(&opts.fromSeq, "from-seq", -1, "resume from this sequence number instead of joining live")
	flag.StringVar(&opts.token, "token", "", "bearer token, if the server requires one")
	flag.StringVar(&opts.out, "out", "", "decode Opus to this WAV file")
	flag.BoolVar(&opts.resumeTest, "resume-test", false,
		"disconnect partway through and reconnect with ?from_seq, checking that the gap is filled")
	flag.DurationVar(&opts.resumeAfter, "resume-after", 2*time.Second,
		"how long to listen before the resume test disconnects")
	flag.BoolVar(&opts.verbose, "v", false, "log every packet header")
	flag.Parse()

	if opts.duration <= 0 {
		return fmt.Errorf("-duration must be positive, got %s", opts.duration)
	}
	if opts.resumeTest && opts.out != "" {
		return errors.New("-out and -resume-test cannot be combined: the reconnect would overwrite the WAV")
	}

	token := opts.token
	if token == "" {
		token = os.Getenv("WEBA_TOKEN")
	}

	// Resolved once, so everything below works against a finished root rather
	// than reassembling the path at each call site.
	opts.baseURL = joinURL(opts.baseURL, opts.basePath)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	client := &http.Client{
		Transport: &http.Transport{
			// The response body is a stream that never ends on its own, so no
			// overall request timeout applies. Only the response headers are
			// bounded, which is what catches an unreachable server.
			ResponseHeaderTimeout: 10 * time.Second,
		},
	}

	info, err := fetchInfo(ctx, client, opts.baseURL, token)
	if err != nil {
		return err
	}
	printInfo(info)

	codecName := opts.codec
	if codecName == "" {
		codecName = info.Codec
	}

	fromSeq, err := initialSeq(opts.fromSeq)
	if err != nil {
		return err
	}

	limit := opts.duration
	if opts.resumeTest {
		limit = opts.resumeAfter
	}

	first, err := listen(ctx, client, opts, token, info, codecName, fromSeq, limit, true)
	if err != nil {
		return err
	}
	printReport(first, info, codecName)

	if opts.resumeTest {
		return resumeCheck(ctx, client, opts, token, info, codecName, first)
	}
	return nil
}

// joinURL appends a base path to a server URL, tolerating slashes on either
// side and an empty path.
func joinURL(serverURL, basePath string) string {
	base := strings.TrimRight(strings.TrimSpace(serverURL), "/")
	path := strings.Trim(basePath, "/")
	if path == "" {
		return base
	}
	return base + "/" + path
}

func initialSeq(value int) (*uint16, error) {
	if value < 0 {
		return nil, nil
	}
	if value > math.MaxUint16 {
		return nil, fmt.Errorf("-from-seq must be in 0..65535, got %d", value)
	}
	seq := uint16(value)
	return &seq, nil
}

// serverInfo mirrors the JSON from GET /audio/info.
type serverInfo struct {
	Version         string   `json:"version"`
	CaptureLib      string   `json:"capture_library"`
	Codec           string   `json:"codec"`
	Codecs          []string `json:"codecs"`
	SampleRate      int      `json:"sample_rate"`
	Channels        int      `json:"channels"`
	FrameSamples    int      `json:"frame_samples"`
	FrameDurationMS float64  `json:"frame_duration_ms"`
	Bitrate         int      `json:"bitrate"`
	Sink            string   `json:"sink"`
	Monitor         string   `json:"monitor"`
	CurrentSeq      uint16   `json:"current_seq"`
	OldestSeq       uint16   `json:"oldest_seq"`
	HistoryPackets  int      `json:"history_packets"`
	Started         bool     `json:"started"`
	Subscribers     int      `json:"subscribers"`
	UptimeSeconds   float64  `json:"uptime_seconds"`
	HeaderSize      int      `json:"header_size"`
	TimestampUnit   string   `json:"timestamp_unit"`
}

func fetchInfo(ctx context.Context, client *http.Client, baseURL, token string) (serverInfo, error) {
	var info serverInfo

	endpoint := strings.TrimSuffix(baseURL, "/") + "/audio/info"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return info, err
	}
	authorize(req, token)

	resp, err := client.Do(req)
	if err != nil {
		return info, fmt.Errorf("fetching /audio/info: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return info, describeHTTPError("GET /audio/info", resp)
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return info, fmt.Errorf("decoding /audio/info: %w", err)
	}
	return info, nil
}

func printInfo(info serverInfo) {
	fmt.Printf("server %s, capture library %s\n", info.Version, info.CaptureLib)
	fmt.Printf("  codec %s (available: %s)\n", info.Codec, strings.Join(info.Codecs, ", "))
	fmt.Printf("  %d Hz, %d ch, %d frames per packet (%.1f ms)\n",
		info.SampleRate, info.Channels, info.FrameSamples, info.FrameDurationMS)
	fmt.Printf("  timestamps count %s, header %d bytes\n", info.TimestampUnit, info.HeaderSize)
	fmt.Printf("  capturing %s\n", info.Monitor)
	fmt.Printf("  seq %d..%d, %d packets of history\n", info.OldestSeq, info.CurrentSeq, info.HistoryPackets)
}

func authorize(req *http.Request, token string) {
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
}

// describeHTTPError renders a non-200 response, including the range headers a
// 416 carries so the caller can pick a valid resume point.
func describeHTTPError(what string, resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	detail := strings.TrimSpace(string(body))

	msg := fmt.Sprintf("%s: %s", what, resp.Status)
	if detail != "" {
		msg += ": " + detail
	}
	if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		msg += fmt.Sprintf(" (available seq %s..%s)",
			resp.Header.Get("X-Audio-Seq-Oldest"), resp.Header.Get("X-Audio-Seq-Current"))
	}
	if codecs := resp.Header.Get("X-Audio-Codecs"); codecs != "" {
		msg += " (supported codecs: " + codecs + ")"
	}
	return errors.New(msg)
}

// payloadSize reports the exact payload length for codecs that have one. Opus
// is variable, so it is exempt.
func payloadSize(codecName string, info serverInfo) (int, bool) {
	switch codecName {
	case "pcm_s16le":
		return info.FrameSamples * info.Channels * 2, true
	case "pcm_f32le":
		return info.FrameSamples * info.Channels * 4, true
	default:
		return 0, false
	}
}

// report accumulates what a stream actually delivered.
type report struct {
	codec     string
	packets   int
	bytes     int
	firstSeq  uint16
	lastSeq   uint16
	firstTS   uint32
	lastTS    uint32
	seqGaps   int
	missing   uint64
	duplicate int
	tsGaps    int
	badLength int
	flags     map[uint8]int
	elapsed   time.Duration
	decodeErr int
	stopped   string
}

func newReport(codecName string) *report {
	return &report{codec: codecName, flags: map[uint8]int{}}
}

// report renders the summary.
func printReport(r *report, info serverInfo, codecName string) {
	fmt.Printf("\nreceived %d packets, %d bytes", r.packets, r.bytes)
	if r.elapsed > 0 {
		fmt.Printf(" (%.1f KiB/s)", float64(r.bytes)/1024/r.elapsed.Seconds())
	}
	fmt.Println()

	if r.packets == 0 {
		fmt.Printf("  nothing arrived (%s)\n", r.stopped)
		return
	}

	audioSeconds := float64(r.packets*info.FrameSamples) / float64(info.SampleRate)
	fmt.Printf("  seq %d..%d, timestamps %d..%d\n", r.firstSeq, r.lastSeq, r.firstTS, r.lastTS)
	fmt.Printf("  %d packets in %s = %.1f packets/s (expected %.1f)\n",
		r.packets, r.elapsed.Round(time.Millisecond),
		float64(r.packets)/r.elapsed.Seconds(), 1000/info.FrameDurationMS)
	fmt.Printf("  %.3f s of audio in %.3f s of wall clock (ratio %.4f)\n",
		audioSeconds, r.elapsed.Seconds(), audioSeconds/r.elapsed.Seconds())

	switch {
	case r.seqGaps > 0:
		fmt.Printf("  sequence: %d gaps covering %d missing packets\n", r.seqGaps, r.missing)
	case r.duplicate > 0:
		fmt.Printf("  sequence: contiguous, %d duplicates\n", r.duplicate)
	default:
		fmt.Printf("  sequence: contiguous\n")
	}

	if r.tsGaps > 0 {
		fmt.Printf("  timestamps: %d steps were not the expected %d samples\n", r.tsGaps, info.FrameSamples)
	} else {
		fmt.Printf("  timestamps: every step was exactly %d samples\n", info.FrameSamples)
	}
	if r.badLength > 0 {
		fmt.Printf("  payloads: %d had an unexpected length for %s\n", r.badLength, codecName)
	}
	if len(r.flags) > 0 {
		bits := make([]int, 0, len(r.flags))
		for bit := range r.flags {
			bits = append(bits, int(bit))
		}
		sort.Ints(bits)
		parts := make([]string, 0, len(bits))
		for _, bit := range bits {
			parts = append(parts, fmt.Sprintf("%s=%d", proto.FlagsString(uint8(bit)), r.flags[uint8(bit)]))
		}
		fmt.Printf("  flags: %s\n", strings.Join(parts, " "))
	}
	if r.decodeErr > 0 {
		fmt.Printf("  decode errors: %d\n", r.decodeErr)
	}
	fmt.Printf("  stream ended because: %s\n", r.stopped)
}

// listen opens the stream and reads packets for up to limit.
func listen(ctx context.Context, client *http.Client, opts options, token string, info serverInfo,
	codecName string, fromSeq *uint16, limit time.Duration, writeWav bool) (*report, error) {

	endpoint, err := url.Parse(strings.TrimSuffix(opts.baseURL, "/") + "/audio/stream")
	if err != nil {
		return nil, err
	}
	query := endpoint.Query()
	query.Set("codec", codecName)
	if fromSeq != nil {
		query.Set("from_seq", strconv.Itoa(int(*fromSeq)))
	}
	endpoint.RawQuery = query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	authorize(req, token)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connecting to the stream: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, describeHTTPError("GET /audio/stream", resp)
	}

	rep := newReport(codecName)
	rep.stopped = "the duration elapsed"

	var decoder *opus.Decoder
	var wav *wavWriter
	if writeWav && opts.out != "" {
		if codecName != "opus" {
			return nil, fmt.Errorf("-out decodes Opus, but the stream is %s", codecName)
		}
		if decoder, err = opus.NewDecoder(info.SampleRate, info.Channels); err != nil {
			return nil, fmt.Errorf("creating the Opus decoder: %w", err)
		}
		if wav, err = newWavWriter(opts.out, info.SampleRate, info.Channels); err != nil {
			return nil, err
		}
		defer func() {
			if err := wav.Close(); err != nil {
				fmt.Fprintf(os.Stderr, "closing the WAV: %v\n", err)
			}
		}()
	}

	started := time.Now()
	deadline := started.Add(limit)
	expectedPayload, hasFixedPayload := payloadSize(codecName, info)

	headerBuf := make([]byte, proto.HeaderSize)
	for {
		if time.Now().After(deadline) {
			break
		}

		if _, err := io.ReadFull(resp.Body, headerBuf); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				rep.stopped = "the server closed the stream"
				rep.elapsed = time.Since(started)
				return rep, nil
			}
			return nil, fmt.Errorf("reading a packet header: %w", err)
		}

		header, err := proto.UnmarshalHeader(headerBuf)
		if err != nil {
			return nil, err
		}

		payload := make([]byte, header.Length)
		if _, err := io.ReadFull(resp.Body, payload); err != nil {
			return nil, fmt.Errorf("reading a payload of %d bytes: %w", header.Length, err)
		}

		if hasFixedPayload && int(header.Length) != expectedPayload {
			rep.badLength++
			if rep.badLength == 1 {
				return nil, fmt.Errorf("first packet: payload is %d bytes, but %s should be %d",
					header.Length, codecName, expectedPayload)
			}
		}

		if opts.verbose {
			fmt.Printf("  %s\n", header)
		}
		observe(rep, header, len(payload), info)

		if decoder != nil && wav != nil {
			out := make([]float32, info.FrameSamples*info.Channels)
			n, err := decoder.DecodeFloat32(payload, out)
			if err != nil {
				rep.decodeErr++
			} else if err := wav.WriteFloat32(out[:n*info.Channels]); err != nil {
				rep.decodeErr++
			}
		}
	}

	rep.elapsed = time.Since(started)
	return rep, nil
}

// observe folds one packet into the report.
func observe(r *report, header proto.Header, payloadBytes int, info serverInfo) {
	if r.packets == 0 {
		r.firstSeq, r.firstTS = header.Seq, header.Timestamp
	} else {
		switch d := proto.SeqDiff(r.lastSeq, header.Seq); {
		case d == 1:
			// contiguous, as it should be
		case d <= 0:
			r.duplicate++
		default:
			r.seqGaps++
			r.missing += uint64(d - 1)
		}
		// The media clock should advance by exactly one frame per packet, and
		// it keeps doing so through silence, so a different step means the
		// timeline moved rather than the packets merely being late.
		if step := header.Timestamp - r.lastTS; step != uint32(info.FrameSamples) {
			r.tsGaps++
		}
	}

	r.lastSeq, r.lastTS = header.Seq, header.Timestamp
	r.packets++
	r.bytes += payloadBytes

	for bit := uint8(1); bit != 0; bit <<= 1 {
		if header.Flags&bit != 0 {
			r.flags[bit]++
		}
	}
}

// resumeCheck disconnects, lets audio accumulate, reconnects with the next
// expected sequence number, and reports whether the missed audio was served.
func resumeCheck(ctx context.Context, client *http.Client, opts options, token string, info serverInfo,
	codecName string, first *report) error {

	if first.packets == 0 {
		return errors.New("the resume test needs at least one packet to have been received")
	}

	next := first.lastSeq + 1
	fmt.Printf("\n--- resume test ---\n")
	fmt.Printf("disconnect after seq %d, resume from seq %d\n", first.lastSeq, next)

	const gap = 1 * time.Second
	fmt.Printf("waiting %s so audio accumulates server-side\n", gap)
	select {
	case <-time.After(gap):
	case <-ctx.Done():
		return ctx.Err()
	}

	resumed, err := listen(ctx, client, opts, token, info, codecName, &next, 3*time.Second, false)
	if err != nil {
		return fmt.Errorf("resuming: %w", err)
	}
	if resumed.packets == 0 {
		return errors.New("the resumed stream delivered no packets")
	}

	fmt.Printf("\nresume result:\n")
	fmt.Printf("  asked for seq %d, first packet was seq %d\n", next, resumed.firstSeq)
	if resumed.firstSeq != next {
		return fmt.Errorf("the server started at seq %d instead of the requested %d", resumed.firstSeq, next)
	}

	replayed := resumed.flags[proto.FlagCatchup]
	fmt.Printf("  %d of %d packets were flagged as replays\n", replayed, resumed.packets)
	if replayed == 0 {
		return errors.New("no packet was flagged as a replay, so the backlog was not served")
	}

	if resumed.seqGaps != 0 {
		return fmt.Errorf("the resumed stream had %d sequence gaps", resumed.seqGaps)
	}
	fmt.Printf("  no sequence gaps across the reconnect\n")
	fmt.Printf("resume test passed\n")
	return nil
}
