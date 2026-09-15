// SPDX-License-Identifier: BSD-3-Clause

package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/lovemilk2333/linux-web-audio/internal/hub"
	"github.com/lovemilk2333/linux-web-audio/internal/proto"
)

const (
	testRate     = 48000
	testChannels = 2
	testFrame    = 240
)

type testSource struct {
	ch chan hub.Frame
}

func newTestSource() *testSource {
	return &testSource{ch: make(chan hub.Frame, 64)}
}

func (s *testSource) Frames() <-chan hub.Frame { return s.ch }

func (s *testSource) Close() error {
	close(s.ch)
	return nil
}

func (s *testSource) send(n int) {
	pcm := make([]float32, testFrame*testChannels)
	for range n {
		s.ch <- hub.Frame{PCM: pcm, Timestamp: time.Now()}
	}
}

func testConfig() hub.Config {
	return hub.Config{
		Codec:          "pcm_s16le",
		SampleRate:     testRate,
		Channels:       testChannels,
		FrameSamples:   testFrame,
		HistoryPackets: 16,
		ClientQueue:    8,
		SlowClient:     hub.FastForward,
	}
}

func startServer(t *testing.T, token string) (*httptest.Server, *testSource) {
	t.Helper()

	h, err := hub.New(testConfig(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("hub.New: %v", err)
	}

	src := newTestSource()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = h.Run(ctx, src)
	}()

	handler := New(Config{
		Hub:       h,
		Token:     token,
		Codecs:    []string{"pcm_s16le"},
		Listen:    "127.0.0.1:8642",
		Log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		StartedAt: time.Now(),
	})
	srv := httptest.NewServer(handler)

	t.Cleanup(func() {
		srv.Close()
		cancel()
		// Closing the source after Run has returned is racy; cancel is enough.
		<-done
		h.Close()
	})
	return srv, src
}

func waitStarted(t *testing.T, src *testSource, srv *httptest.Server) {
	t.Helper()
	src.send(1)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		// /healthz is outside the auth check, so this still works when a token
		// is configured. 503 means no frame has been processed yet.
		resp, err := http.Get(srv.URL + "/healthz")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("hub never started")
}

func TestWebSocketDeliversOneBinaryPacket(t *testing.T) {
	srv, src := startServer(t, "")
	waitStarted(t, src, srv)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/audio/stream?codec=pcm_s16le"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.CloseNow()

	src.send(1)

	typ, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("message type = %v, want binary", typ)
	}

	header, payload, err := proto.Unmarshal(data)
	if err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	want := testFrame * testChannels * 2
	if len(payload) != want {
		t.Fatalf("payload length = %d, want %d", len(payload), want)
	}
	if header.Length != uint32(want) {
		t.Fatalf("header length = %d, want %d", header.Length, want)
	}
}

func TestHTTPStreamStillWorks(t *testing.T) {
	srv, src := startServer(t, "")
	waitStarted(t, src, srv)

	resp, err := http.Get(srv.URL + "/audio/stream?codec=pcm_s16le")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	src.send(1)

	buf := make([]byte, proto.HeaderSize+testFrame*testChannels*2)
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatalf("ReadFull: %v", err)
	}
	if _, _, err := proto.Unmarshal(buf); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
}

func TestStream416StaysHTTP(t *testing.T) {
	srv, src := startServer(t, "")
	waitStarted(t, src, srv)

	resp, err := http.Get(srv.URL + "/audio/stream?codec=pcm_s16le&from_seq=40000")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("status = %d, want 416", resp.StatusCode)
	}
	if resp.Header.Get("X-Audio-Seq-Oldest") == "" || resp.Header.Get("X-Audio-Seq-Current") == "" {
		t.Fatal("416 is missing the sequence range headers")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/audio/stream?codec=pcm_s16le&from_seq=40000"
	_, _, err = websocket.Dial(ctx, wsURL, nil)
	if err == nil {
		t.Fatal("a 416 handshake succeeded; Subscribe should have refused before the upgrade")
	}
}

func TestStreamTokenQuery(t *testing.T) {
	srv, src := startServer(t, "secret")
	waitStarted(t, src, srv)

	resp, err := http.Get(srv.URL + "/audio/stream?codec=pcm_s16le")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated HTTP = %d, want 401", resp.StatusCode)
	}

	resp, err = http.Get(srv.URL + "/audio/info")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated /audio/info = %d, want 401", resp.StatusCode)
	}

	resp, err = http.Get(srv.URL + "/audio/info?token=secret")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/audio/info accepted ?token=, want 401")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/audio/stream?codec=pcm_s16le&token=secret"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("Dial with ?token=: %v", err)
	}
	defer conn.CloseNow()

	src.send(1)
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatalf("Read after ?token=: %v", err)
	}

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/audio/stream?codec=pcm_s16le", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer secret")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Authorization bearer = %d, want 200", resp.StatusCode)
	}
}
