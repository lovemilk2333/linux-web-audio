// SPDX-License-Identifier: BSD-3-Clause

// Package server exposes the audio stream over HTTP.
//
// Two endpoints matter to a client:
//
//	GET /audio/info    capability discovery, in JSON
//	GET /audio/stream  the stream itself: WebSocket binary messages, or a
//	                   chunked HTTP response of the same framed packets
//
// A client should read /audio/info first, then connect to /audio/stream,
// optionally passing ?from_seq to resume where it left off. A browser should
// open a WebSocket; anything that cannot upgrade still reads the chunked body.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/lovemilk2333/linux-web-audio/internal/codec"
	"github.com/lovemilk2333/linux-web-audio/internal/hub"
	"github.com/lovemilk2333/linux-web-audio/internal/proto"
	"github.com/lovemilk2333/linux-web-audio/internal/source"
)

// Version is the server version reported by /audio/info and --version.
const Version = "1.0.0"

// Config configures the HTTP surface.
type Config struct {
	Hub    *hub.Hub
	Source *source.Source
	Token  string
	Codecs []string
	// CaptureLibrary is the capture library's version, reported by /audio/info.
	CaptureLibrary string
	// BasePath is the prefix every endpoint is mounted under, so the API can
	// sit beside a web page on the same origin and be proxied without
	// rewriting. Empty or "/" mounts at the root.
	BasePath string
	// Listen is the address being served, used to seed the Host allow-list.
	Listen string
	// AllowedHosts are extra Host names to answer to, or "*" to accept any.
	AllowedHosts []string
	// CORSOrigins lists the origins allowed to call the API from a browser.
	// Empty disables CORS, which is the default: a separately served page is a
	// cross-origin client and cannot work without this.
	CORSOrigins []string
	Log         *slog.Logger
	StartedAt   time.Time
}

// Server implements http.Handler.
type Server struct {
	cfg       Config
	mux       *http.ServeMux
	cors      corsPolicy
	basePath  string
	hostGuard hostGuard
}

// New builds the HTTP handler. The returned handler applies authentication when
// a token is configured.
func New(cfg Config) http.Handler {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}

	guard, err := NewHostGuard(cfg.Listen, cfg.AllowedHosts)
	if err != nil {
		panic(err)
	}

	s := &Server{
		cfg:       cfg,
		mux:       http.NewServeMux(),
		cors:      newCORSPolicy(cfg.CORSOrigins),
		hostGuard: guard,
	}

	base, err := NormaliseBasePath(cfg.BasePath)
	if err != nil {
		// Programmer error rather than a request-time failure: the flag is
		// validated when it is parsed, so reaching here means a caller
		// constructed the config directly.
		panic(err)
	}
	s.basePath = base

	s.mux.HandleFunc("GET "+base+"/audio/info", s.handleInfo)
	s.mux.HandleFunc("GET "+base+"/audio/stream", s.handleStream)
	s.mux.HandleFunc("GET "+base+"/healthz", s.handleHealth)

	// The Host check is outermost: a request arriving under a name this server
	// does not answer to is refused before it is parsed or answered at all.
	// Then CORS, which a browser sends its preflight for without the
	// Authorization header. Health stays outside the auth check so a probe
	// needs no secret.
	return s.withHostGuard(s.withCORS(s.authenticate(s.mux)))
}

// NormaliseBasePath validates a base path and returns it in the form the mux
// wants: empty for the root, otherwise "/something" with no trailing slash.
func NormaliseBasePath(path string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(path), "/")
	if trimmed == "" {
		return "", nil
	}
	if strings.Contains(trimmed, "//") {
		return "", fmt.Errorf("invalid base path %q: empty segments", path)
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == "." || segment == ".." {
			return "", fmt.Errorf("invalid base path %q: relative segments", path)
		}
	}
	return "/" + trimmed, nil
}

// Path returns the full path of an endpoint, for logs and for /healthz.
func (s *Server) Path(endpoint string) string {
	return s.basePath + endpoint
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.Token == "" || r.URL.Path == s.Path("/healthz") {
			next.ServeHTTP(w, r)
			return
		}

		provided, ok := bearerToken(r)
		// Browsers cannot set Authorization on WebSocket(), so the stream
		// also accepts ?token=. It will appear in reverse-proxy access logs;
		// that is the cost of a handshake the page cannot otherwise authenticate.
		if !ok && r.URL.Path == s.Path("/audio/stream") {
			if q := r.URL.Query().Get("token"); q != "" {
				provided, ok = q, true
			}
		}
		if !ok || provided != s.cfg.Token {
			w.Header().Set("WWW-Authenticate", `Bearer realm="linux-web-audio"`)
			writeJSONError(w, http.StatusUnauthorized, "a bearer token is required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func bearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", false
	}
	return strings.TrimSpace(header[len(prefix):]), true
}

// infoResponse is the body of GET /audio/info.
type infoResponse struct {
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
	CaptureReopens  int      `json:"capture_reopens"`
	HeaderSize      int      `json:"header_size"`
	TimestampUnit   string   `json:"timestamp_unit"`
	EncodeUs        uint64   `json:"encode_us"`
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	stats := s.cfg.Hub.Stats()

	resp := infoResponse{
		Version:         Version,
		CaptureLib:      s.cfg.CaptureLibrary,
		Codec:           stats.Codec,
		Codecs:          s.cfg.Codecs,
		SampleRate:      stats.SampleRate,
		Channels:        stats.Channels,
		FrameSamples:    stats.FrameSamples,
		FrameDurationMS: stats.FrameDurationMS,
		Bitrate:         stats.Bitrate,
		CurrentSeq:      stats.CurrentSeq,
		OldestSeq:       stats.OldestSeq,
		HistoryPackets:  stats.HistoryPackets,
		Started:         stats.Started,
		Subscribers:     stats.Subscribers,
		UptimeSeconds:   time.Since(s.cfg.StartedAt).Seconds(),
		HeaderSize:      proto.HeaderSize,
		// The timestamp counts samples rather than wall clock, so it stays
		// exact and evenly spaced even while the desktop is silent.
		TimestampUnit: "samples",
		EncodeUs:      stats.EncodeUs,
	}

	if s.cfg.Source != nil {
		resp.CaptureReopens = s.cfg.Source.Reopens()
		info := s.cfg.Source.Info()
		resp.Sink = info.SinkName
		resp.Monitor = info.MonitorName
	}

	writeJSON(w, http.StatusOK, resp)
}

// handleStream serves the audio stream.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	codecName := r.URL.Query().Get("codec")
	if codecName == "" {
		codecName = s.cfg.Hub.DefaultCodec()
	}
	if _, ok := codec.Lookup(codecName); !ok {
		w.Header().Set("X-Audio-Codecs", strings.Join(codec.Names(), ","))
		writeJSONError(w, http.StatusBadRequest,
			fmt.Sprintf("unsupported codec %q, supported codecs: %s", codecName, strings.Join(codec.Names(), ", ")))
		return
	}

	fromSeq, err := parseFromSeq(r.URL.Query())
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	sub, err := s.cfg.Hub.Subscribe(codecName, fromSeq)
	if err != nil {
		if errors.Is(err, hub.ErrSeqOutOfRange) {
			stats := s.cfg.Hub.Stats()
			// Tell the client exactly what is available so it can choose a
			// valid point and retry, the way a 416 does for byte ranges.
			w.Header().Set("X-Audio-Seq-Oldest", strconv.Itoa(int(stats.OldestSeq)))
			w.Header().Set("X-Audio-Seq-Current", strconv.Itoa(int(stats.CurrentSeq)))
			writeJSONError(w, http.StatusRequestedRangeNotSatisfiable, err.Error())
			return
		}
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer sub.Close()

	stats := s.cfg.Hub.Stats()
	startSeq := stats.CurrentSeq + 1
	if fromSeq != nil {
		startSeq = *fromSeq
	}

	header := w.Header()
	header.Set("Content-Type", "application/octet-stream")
	header.Set("Cache-Control", "no-store")
	header.Set("X-Audio-Codec", codecName)
	header.Set("X-Audio-SampleRate", strconv.Itoa(stats.SampleRate))
	header.Set("X-Audio-Channels", strconv.Itoa(stats.Channels))
	header.Set("X-Audio-Frame-Samples", strconv.Itoa(stats.FrameSamples))
	header.Set("X-Audio-Frame-Duration-Ms", strconv.FormatFloat(stats.FrameDurationMS, 'f', -1, 64))
	header.Set("X-Audio-Header-Size", strconv.Itoa(proto.HeaderSize))
	header.Set("X-Audio-Seq-Start", strconv.Itoa(int(startSeq)))

	buffer := parseBufferMs(r.URL.Query())

	if wantsWebSocket(r) {
		s.serveWebSocket(w, r, sub, buffer)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "the connection does not support streaming")
		return
	}

	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// The response stays open until the client goes away or the stream ends.
	// Nothing below writes a status code, so the 200 stands.
	s.writePackets(r.Context(), sub, buffer, func(buf []byte) error {
		if _, err := w.Write(buf); err != nil {
			return err
		}
		// Flushed per packet: at one packet per frame period this is the
		// difference between live audio and audio that arrives in bursts.
		flusher.Flush()
		return nil
	})
}

// wantsWebSocket reports a handshake. Checked after Subscribe so 400 / 416
// stay ordinary HTTP JSON: the browser WebSocket constructor cannot read
// those headers, and the page falls back to fetch for that attempt.
func wantsWebSocket(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

func (s *Server) serveWebSocket(w http.ResponseWriter, r *http.Request, sub *hub.Subscriber, buffer time.Duration) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Host-guard already refused a rebound Host. CORS does not apply to
		// WebSocket, and behind a reverse proxy the Origin is the page while
		// the backend Host is 127.0.0.1 — matching them would reject the
		// same-origin proxy case this is built for.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		s.cfg.Log.Debug("websocket accept failed", "error", err)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// CloseRead notices the client going away (and answers pings) so the
	// write loop's context ends instead of blocking on the next packet.
	ctx := conn.CloseRead(r.Context())
	s.writePackets(ctx, sub, buffer, func(buf []byte) error {
		return conn.Write(ctx, websocket.MessageBinary, buf)
	})
}

// writePackets frames each hub packet and hands it to send, until the
// subscriber ends or send fails.
//
// Live packets wait on capture, which is already 1×. A backlog — resume
// catchup, a live-join prefill, or a queue that built up — is paced at 2×
// the frame rate until it is 5 ms ahead, then 1.25× until it reaches the
// client's play buffer, then 0.75× so the buffer cannot grow without bound.
func (s *Server) writePackets(ctx context.Context, sub *hub.Subscriber, buffer time.Duration, send func([]byte) error) {
	stats := s.cfg.Hub.Stats()
	frame := time.Duration(stats.FrameDurationMS * float64(time.Millisecond))
	pacer := hub.SendPacer{Frame: frame, Buffer: buffer}

	// A live join has no catchup. Prefill one play-buffer of history so
	// the first packets go out at 2× instead of waiting a whole target
	// at 1×.
	s.prefillRecent(sub, buffer, frame, false)

	buf := make([]byte, 0, proto.HeaderSize+2048)
	sent := 0
	var nextAt time.Time
	for {
		if !nextAt.IsZero() {
			if wait := time.Until(nextAt); wait > 0 {
				timer := time.NewTimer(wait)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
		}

		pkt, err := sub.Next(ctx)
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, ctx.Err()) {
				s.cfg.Log.Debug("stream ended", "error", err, "packets", sent)
			}
			return
		}

		// FastForward (and a capture reopen) leave a hole. Live 1×
		// cannot refill the play buffer. Queue a target of history
		// *before* this packet so the client hears it in order, then
		// send at 2×. Catchup already went through this path; prefill
		// again would loop. The dequeued packet is in Recent, so it
		// is not sent here. History does not store the FastForward
		// flag, so the first refill packet is marked discontinuous.
		if pkt.Flags&proto.FlagDiscontinuity != 0 &&
			pkt.Flags&proto.FlagCatchup == 0 &&
			sub.Backlog() == 0 &&
			buffer > 0 && frame > 0 {
			if s.prefillRecent(sub, buffer, frame, true) {
				pacer.Reset()
				continue
			}
		}

		buf = proto.AppendPacket(buf[:0], proto.Header{
			Flags:     pkt.Flags,
			Seq:       pkt.Seq,
			Timestamp: pkt.Timestamp,
		}, pkt.Payload)

		if err := send(buf); err != nil {
			return
		}
		sent++

		now := time.Now()
		interval := pacer.ObserveSend(now)
		if sub.Backlog() > 0 {
			nextAt = now.Add(interval)
		} else {
			// Capture already spaces live packets. Sleeping here would
			// only make the subscriber queue grow.
			pacer.Reset()
			nextAt = time.Time{}
		}
	}
}

// prefillRecent queues about one play-buffer of history when the subscriber
// has nothing waiting. markGap sets FlagDiscontinuity on the first packet:
// FastForward adds that flag at push time, and history does not store it.
func (s *Server) prefillRecent(sub *hub.Subscriber, buffer, frame time.Duration, markGap bool) bool {
	if sub.Backlog() > 0 || buffer <= 0 || frame <= 0 {
		return false
	}
	n := int(buffer/frame) + 1
	if n <= 0 {
		return false
	}
	refill := s.cfg.Hub.Recent(sub.Codec(), n)
	if len(refill) == 0 {
		return false
	}
	if markGap {
		refill[0].Flags |= proto.FlagDiscontinuity
	}
	sub.Prefill(refill)
	return true
}

// parseBufferMs reads the client's play-buffer target from ?buffer_ms.
// That is the 0.75× ceiling and the live-join prefill. Missing or unusable
// values mean no prefill and no 0.75× cap, so CLI clients keep joining at
// the live edge.
func parseBufferMs(q url.Values) time.Duration {
	raw := q.Get("buffer_ms")
	if raw == "" {
		return 0
	}
	ms, err := strconv.ParseFloat(raw, 64)
	if err != nil || ms <= 0 {
		return 0
	}
	if ms > 1500 {
		ms = 1500
	}
	return time.Duration(ms * float64(time.Millisecond))
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Hub.Stats().Started {
		http.Error(w, "no audio has been captured yet", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "ok\n")
}

// parseFromSeq reads the resume point from ?from_seq or its ?seq alias.
func parseFromSeq(q url.Values) (*uint16, error) {
	raw := q.Get("from_seq")
	if raw == "" {
		raw = q.Get("seq")
	}
	if raw == "" {
		return nil, nil
	}
	value, err := strconv.ParseUint(raw, 10, 16)
	if err != nil {
		return nil, fmt.Errorf("invalid sequence number %q: expected an integer in 0..65535", raw)
	}
	seq := uint16(value)
	return &seq, nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(body)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"error":  http.StatusText(status),
		"status": status,
		"detail": message,
	})
}
