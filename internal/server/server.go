// SPDX-License-Identifier: BSD-3-Clause

// Package server exposes the audio stream over HTTP.
//
// Two endpoints matter to a client:
//
//	GET /audio/info    capability discovery, in JSON
//	GET /audio/stream  the stream itself, a chunked response of framed packets
//
// A client should read /audio/info first, then connect to /audio/stream,
// optionally passing ?from_seq to resume where it left off.
package server

import (
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
	// CORSOrigins lists the origins allowed to call the API from a browser.
	// Empty disables CORS, which is the default: a separately served page is a
	// cross-origin client and cannot work without this.
	CORSOrigins []string
	Log         *slog.Logger
	StartedAt   time.Time
}

// Server implements http.Handler.
type Server struct {
	cfg      Config
	mux      *http.ServeMux
	cors     corsPolicy
	basePath string
}

// New builds the HTTP handler. The returned handler applies authentication when
// a token is configured.
func New(cfg Config) http.Handler {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}

	s := &Server{cfg: cfg, mux: http.NewServeMux(), cors: newCORSPolicy(cfg.CORSOrigins)}

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

	// CORS is outermost: a browser sends its preflight without the
	// Authorization header, so it has to be answered before the auth check.
	// Health stays outside the auth check so a probe needs no secret.
	return s.withCORS(s.authenticate(s.mux))
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

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "the connection does not support streaming")
		return
	}

	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// The response stays open until the client goes away or the stream ends.
	// Nothing below writes a status code, so the 200 stands.
	buf := make([]byte, 0, proto.HeaderSize+2048)
	sent := 0

	for {
		pkt, err := sub.Next(r.Context())
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, r.Context().Err()) {
				s.cfg.Log.Debug("stream ended", "error", err, "packets", sent)
			}
			return
		}

		buf = proto.AppendPacket(buf[:0], proto.Header{
			Flags:     pkt.Flags,
			Seq:       pkt.Seq,
			Timestamp: pkt.Timestamp,
		}, pkt.Payload)

		if _, err := w.Write(buf); err != nil {
			return
		}
		// Flushed per packet: at one packet per frame period this is the
		// difference between live audio and audio that arrives in bursts.
		flusher.Flush()
		sent++
	}
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
