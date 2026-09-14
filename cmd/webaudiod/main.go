// SPDX-License-Identifier: BSD-3-Clause

// Command webaudiod captures desktop audio and streams it over HTTP.
//
// The stream is a long-lived chunked response: a sequence of 16-byte headers
// each followed by one encoded packet. GET /audio/info describes the stream and
// is the endpoint a client should consult first; GET /audio/stream?from_seq=N
// resumes from a sequence number the client has already seen.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lovemilk2333/linux-web-audio/internal/capweba"
	"github.com/lovemilk2333/linux-web-audio/internal/codec"
	"github.com/lovemilk2333/linux-web-audio/internal/hub"
	"github.com/lovemilk2333/linux-web-audio/internal/server"
	"github.com/lovemilk2333/linux-web-audio/internal/source"
)

type options struct {
	listen         string
	codecs         string
	bitrate        int
	complexity     int
	frameDuration  float64
	sampleRate     int
	channels       int
	sink           string
	historyPackets int
	clientQueue    int
	slowClient     string
	token          string
	cors           string
	basePath       string
	vbr            bool
	dtx            bool
	fec            bool
	logLevel       string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "webaudiod: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var opts options

	flag.StringVar(&opts.listen, "listen", "127.0.0.1:8642",
		"address to listen on. The default is loopback only, because this streams what the desktop is playing")
	flag.StringVar(&opts.codecs, "codec", "opus",
		"codec used for clients that do not request one, or a comma-separated list. Supported: "+strings.Join(codec.Names(), ", "))
	flag.IntVar(&opts.bitrate, "bitrate", 96000, "target bitrate in bits per second, where the codec has one")
	flag.IntVar(&opts.complexity, "complexity", 5, "encoder effort, where the codec has one")
	flag.Float64Var(&opts.frameDuration, "frame-duration", 10, "frame duration in ms (Opus accepts 2.5, 5, 10, 20, 40, 60)")
	flag.IntVar(&opts.sampleRate, "sample-rate", 48000, "capture sample rate in Hz")
	flag.IntVar(&opts.channels, "channels", 2, "capture channel count (1, 2, 6 or 8)")
	flag.StringVar(&opts.sink, "sink", "",
		"sink whose monitor to capture; empty follows the current default sink")
	flag.IntVar(&opts.historyPackets, "history-packets", 750,
		"packets of recent audio kept so a client can resume with ?from_seq")
	flag.IntVar(&opts.clientQueue, "client-queue", 64, "packets buffered per client before the slow-client policy applies")
	flag.StringVar(&opts.slowClient, "slow-client", "fast-forward",
		"what to do with a client that falls behind: fast-forward, drop or disconnect")
	flag.StringVar(&opts.token, "token", "", "require this bearer token on every request (or set WEBA_TOKEN)")
	flag.StringVar(&opts.basePath, "base-path", "/backend",
		"prefix every endpoint is mounted under, so the API can sit beside a web page on one origin. Empty mounts at the root")
	flag.StringVar(&opts.cors, "cors", "",
		"origins allowed to call this API from a browser, comma separated, or * for any. A separately served web page needs this")
	flag.BoolVar(&opts.vbr, "vbr", false, "use variable bitrate where supported (Opus runs in constant bitrate by default, as Sunshine does)")
	flag.BoolVar(&opts.dtx, "dtx", false, "enable discontinuous transmission where supported")
	flag.BoolVar(&opts.fec, "fec", false, "enable in-band forward error correction where supported")
	flag.StringVar(&opts.logLevel, "log-level", "info", "log level: debug, info, warning or error")

	version := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *version {
		fmt.Printf("webaudiod %s (capture library %s)\n", server.Version, capweba.Version())
		return nil
	}

	logger, err := newLogger(opts.logLevel)
	if err != nil {
		return err
	}

	token, err := resolveToken(opts.token)
	if err != nil {
		return err
	}

	codecNames, err := codec.ParseList(opts.codecs)
	if err != nil {
		return err
	}
	if len(codecNames) > 1 {
		logger.Warn("more than one codec given; the first is the default and the rest are offered on request",
			"default", codecNames[0], "available", codecNames[1:])
	}

	slowPolicy, err := hub.ParseSlowPolicy(opts.slowClient)
	if err != nil {
		return err
	}

	corsOrigins, err := server.ParseCORSOrigins(opts.cors)
	if err != nil {
		return err
	}

	basePath, err := server.NormaliseBasePath(opts.basePath)
	if err != nil {
		return err
	}

	frameSamples, err := frameSamplesFor(opts.sampleRate, opts.frameDuration)
	if err != nil {
		return err
	}

	// Checked before the capture is opened, so a bad address fails immediately
	// rather than after the audio device has been claimed and released.
	if err := checkListen(opts.listen, token != "", logger); err != nil {
		return err
	}

	hubCfg := hub.Config{
		Codec:          codecNames[0],
		SampleRate:     opts.sampleRate,
		Channels:       opts.channels,
		FrameSamples:   frameSamples,
		Bitrate:        opts.bitrate,
		Complexity:     opts.complexity,
		VBR:            opts.vbr,
		DTX:            opts.dtx,
		FEC:            opts.fec,
		HistoryPackets: opts.historyPackets,
		ClientQueue:    opts.clientQueue,
		SlowClient:     slowPolicy,
	}

	broadcast, err := hub.New(hubCfg, logger)
	if err != nil {
		return err
	}
	defer broadcast.Close()

	src, err := source.Open(source.Config{
		SampleRate:   opts.sampleRate,
		Channels:     opts.channels,
		FrameSamples: frameSamples,
		Sink:         opts.sink,
	}, logger)
	if err != nil {
		return fmt.Errorf("starting capture: %w", err)
	}
	defer src.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	/* A second signal exits at once.
	 *
	 * The first asks for a graceful stop, which waits for open connections to
	 * finish — and a client streaming audio holds one open for as long as it
	 * likes. Pressing Ctrl+C again is how anyone insists, and having it do
	 * nothing while the process looks stuck is worse than exiting abruptly.
	 * Shutdown has already closed the listening socket by then, so the port is
	 * free either way. */
	watchForSecondSignal(ctx, logger)

	runErr := make(chan error, 1)
	go func() { runErr <- broadcast.Run(ctx, src) }()

	handler := server.New(server.Config{
		Hub:            broadcast,
		Source:         src,
		Token:          token,
		Codecs:         codecNames,
		CaptureLibrary: capweba.Version(),
		CORSOrigins:    corsOrigins,
		BasePath:       basePath,
		Log:            logger,
		StartedAt:      time.Now(),
	})

	httpServer := &http.Server{
		Addr:    opts.listen,
		Handler: handler,
		// A stream is a long-lived response and must not be cut off by a
		// write deadline, so only the header read is bounded.
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("listening",
			"address", opts.listen,
			"base_path", basePath,
			"codec", codecNames[0],
			"sample_rate", opts.sampleRate,
			"channels", opts.channels,
			"frame_samples", frameSamples,
			"frame_duration_ms", opts.frameDuration,
			"auth", token != "",
			"cors", opts.cors)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	select {
	case err := <-serveErr:
		if err != nil {
			return fmt.Errorf("http server: %w", err)
		}
		return nil
	case err := <-runErr:
		if err != nil && !errors.Is(err, context.Canceled) {
			return fmt.Errorf("capture pipeline: %w", err)
		}
		return nil
	case <-ctx.Done():
		// Said before the wait, because a streaming client keeps a connection
		// open and the pause that follows can look like a hang.
		logger.Info("shutting down; press Ctrl+C again to exit without waiting")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Warn("graceful shutdown did not complete", "error", err)
	}
	return nil
}

// watchForSecondSignal exits the process if a further signal arrives while the
// first is being handled.
func watchForSecondSignal(ctx context.Context, logger *slog.Logger) {
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-ctx.Done()
		select {
		case <-interrupts:
			logger.Warn("second signal, exiting now rather than waiting for open connections")
			os.Exit(130) // 128 + SIGINT, the conventional code for this
		case <-time.After(10 * time.Second):
			// The graceful path should be long done; stop watching.
		}
		signal.Stop(interrupts)
	}()
}

// checkListen validates the listen address and warns when it is about to expose
// the machine's audio more widely than the operator may realise.
//
// The address is passed straight to the listener, whose own error for a missing
// host is "missing port in address" — which sends you looking at the port you
// did supply. Validating here says what is actually wrong.
func checkListen(addr string, hasToken bool, logger *slog.Logger) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid --listen %q: expected host:port, for example 127.0.0.1:8642, "+
			"or :8642 for every interface", addr)
	}

	number, err := strconv.Atoi(port)
	if err != nil {
		return fmt.Errorf("invalid --listen %q: %q is not a port number", addr, port)
	}
	if number < 1 || number > 65535 {
		return fmt.Errorf("invalid --listen %q: port %d is outside 1..65535", addr, number)
	}

	// An empty host means every interface. Anything not loopback is reachable
	// from the network, which for a stream of the desktop's audio is worth
	// saying out loud when there is no token in front of it.
	if !hasToken && !isLoopback(host) {
		logger.Warn("listening beyond this machine without a token: anyone who can reach this port "+
			"can listen to this machine's audio; pass --token, or use --listen 127.0.0.1:8642",
			"address", addr)
	}
	return nil
}

// isLoopback reports whether a listen host is reachable only locally.
func isLoopback(host string) bool {
	switch host {
	case "", "localhost":
		// An empty host is every interface, not loopback.
		return host == "localhost"
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// frameSamplesFor converts a frame duration in milliseconds to a sample count.
func frameSamplesFor(sampleRate int, ms float64) (int, error) {
	if sampleRate <= 0 {
		return 0, fmt.Errorf("sample rate must be positive, got %d", sampleRate)
	}
	if ms <= 0 {
		return 0, fmt.Errorf("frame duration must be positive, got %g ms", ms)
	}
	samples := int(ms*float64(sampleRate)/1000 + 0.5)
	if samples <= 0 {
		return 0, fmt.Errorf("a frame duration of %g ms is too short at %d Hz", ms, sampleRate)
	}
	// A frame that does not divide the rate exactly would drift the timestamp
	// against the wall clock, so reject it rather than accumulate error.
	if actual := float64(samples) * 1000 / float64(sampleRate); diff(actual, ms) > 0.01 {
		return 0, fmt.Errorf("a frame duration of %g ms is not representable at %d Hz (nearest is %.3f ms)",
			ms, sampleRate, actual)
	}
	return samples, nil
}

func diff(a, b float64) float64 {
	if a > b {
		return a - b
	}
	return b - a
}

func resolveToken(flagValue string) (string, error) {
	if flagValue != "" {
		return flagValue, nil
	}
	return os.Getenv("WEBA_TOKEN"), nil
}

func newLogger(level string) (*slog.Logger, error) {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "info":
		lvl = slog.LevelInfo
	case "warning", "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		return nil, fmt.Errorf("unknown log level %q, expected debug, info, warning or error", level)
	}
	handler := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lvl})
	return slog.New(handler), nil
}
