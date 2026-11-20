package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// app holds everything the two HTTP servers share.
//
// Security model:
//   - The control API listens on loopback only and every request must carry
//     the random token printed on stdout at startup (X-Cast-Token). Requests
//     with an Origin header or an unexpected Host header are refused, so a web
//     page (CSRF, DNS rebinding) cannot drive the helper.
//   - The media server only exists while a cast session is active, is bound to
//     the one local address that reaches the device, serves exactly one file
//     under an unguessable per-session path, and only answers the device's IP.
type app struct {
	mu          sync.Mutex
	src         source       // what is being served: a local file or a stream URL
	plan        *plan        // how it is converted; nil = served untouched
	title       string       // shown on the device
	contentType string       // content type advertised to the device in LOAD
	mediaURL    string       // URL handed to the device for this session
	subs        *subtitleJob // subtitle track being sent, or nil
	mediaToken  string       // random path component for the current session
	deviceIP    netip.Addr   // the only address allowed to fetch the media
	cast        *castConn    // active connection, or nil
	mediaSrv    *http.Server // running only while a session is active

	token       string // control API secret
	controlAddr string // host:port the control API listens on
	mediaPort   string // port the media server binds to
	mediaBindIP string // optional override for the media bind/advertise address

	tools          *tools // ffmpeg/ffprobe, nil if not installed
	ffmpegOverride string // -ffmpeg flag

	discovery  discovery          // Cast devices seen on the LAN
	convCancel context.CancelFunc // stops the running conversion, if any
	convSeq    uint64

	mediaHits atomic.Uint64 // how many times the device has fetched the media
	reqSeq    atomic.Uint64 // request counter, for correlating log lines
}

// lookupTools is replaced in tests that must run without ffmpeg.
var lookupTools = findTools

// allowLoopbackDevice lets tests cast to a fake device on 127.0.0.1.
var allowLoopbackDevice = false

// Media file types. Anything else is refused, so the helper can never be
// talked into serving arbitrary files.
var mediaExtensions = map[string]bool{
	".mp4": true, ".m4v": true, ".mov": true, ".webm": true, ".mkv": true,
	".avi": true, ".ts": true, ".m2ts": true, ".mts": true, ".mpg": true,
	".mpeg": true, ".wmv": true, ".flv": true, ".3gp": true, ".ogv": true,
	".mp3": true, ".m4a": true, ".aac": true, ".ogg": true, ".oga": true,
	".opus": true, ".flac": true, ".wav": true, ".mka": true, ".ac3": true,
	".wma": true, ".m4b": true,
}

func main() {
	controlAddr := flag.String("control", "127.0.0.1:9092", "loopback control API address (for the IINA plugin)")
	mediaAddr := flag.String("media", ":8010", "media server port; a specific host part overrides the autodetected bind address")
	advertiseIP := flag.String("ip", "", "LAN IP to bind and advertise to the device (default: the address that reaches the device)")
	verbosity := flag.Int("v", lvlInfo, "log verbosity: 0=error 1=warn 2=info 3=debug 4=trace (protobuf wire dumps)")
	logPath := flag.String("log", "", "also append logs to this file (created 0600; default: stderr only)")
	ffmpegPath := flag.String("ffmpeg", "", "path to ffmpeg (default: look in the usual install locations)")
	ffmpegDirs := flag.String("ffmpeg-dirs", "", "colon-separated extra folders to look for a manually downloaded ffmpeg")
	flag.Parse()
	for _, d := range strings.Split(*ffmpegDirs, ":") {
		if filepath.IsAbs(d) {
			userToolDirs = append(userToolDirs, filepath.Clean(d))
		}
	}

	setupLogging(*logPath, *verbosity)
	logInfo("=== casthelper starting: pid=%d ===", os.Getpid())

	ctrlHost, _, err := net.SplitHostPort(*controlAddr)
	if err != nil {
		logError("cannot parse -control address %q: %v", *controlAddr, err)
		os.Exit(1)
	}
	if ip, err := netip.ParseAddr(ctrlHost); err != nil || !ip.IsLoopback() {
		logError("-control must be a loopback IP address, got %q", ctrlHost)
		os.Exit(1)
	}

	mediaHost, mediaPort, err := net.SplitHostPort(*mediaAddr)
	if err != nil {
		logError("cannot parse -media address %q: %v", *mediaAddr, err)
		os.Exit(1)
	}
	bindIP := *advertiseIP
	if bindIP == "" && mediaHost != "" && mediaHost != "0.0.0.0" && mediaHost != "::" {
		bindIP = mediaHost
	}
	if bindIP != "" {
		if _, err := netip.ParseAddr(bindIP); err != nil {
			logError("media bind address %q is not an IP address", bindIP)
			os.Exit(1)
		}
	}

	token, err := randomToken()
	if err != nil {
		logError("cannot generate control token: %v", err)
		os.Exit(1)
	}

	a := &app{
		token:          token,
		controlAddr:    *controlAddr,
		mediaPort:      mediaPort,
		mediaBindIP:    bindIP,
		tools:          findTools(*ffmpegPath),
		ffmpegOverride: *ffmpegPath,
	}
	if a.tools == nil {
		logWarn("ffmpeg not found: files the device cannot play directly, and network streams, cannot be cast")
	} else {
		logInfo("using %s for conversion", a.tools.ffmpeg)
	}

	ctrlLn, err := net.Listen("tcp", *controlAddr)
	if err != nil {
		logError("control API cannot bind %s: %v (another casthelper still running?)", *controlAddr, err)
		os.Exit(1)
	}
	logInfo("control API listening on %s", ctrlLn.Addr())
	ctrlSrv := &http.Server{
		Handler:           a.controlMux(),
		ReadHeaderTimeout: 5 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	go func() {
		if err := ctrlSrv.Serve(ctrlLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logError("control server stopped: %v", err)
			os.Exit(1)
		}
	}()

	// Signal the plugin (which reads our stdout) that we're up, and hand it the
	// secret it must present on every control request.
	fmt.Printf("READY %s\n", token)
	logInfo("wrote READY to stdout; waiting for control requests")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go watchParent(sig)
	s := <-sig
	logInfo("received signal %s, shutting down", s)
	a.stopSession(true)
	logInfo("=== casthelper exiting ===")
}

// watchParent shuts the helper down when the process that started it (IINA)
// goes away, so no listener outlives the player.
func watchParent(sig chan<- os.Signal) {
	parent := os.Getppid()
	if parent <= 1 {
		return
	}
	for range time.Tick(2 * time.Second) {
		if os.Getppid() != parent {
			logInfo("parent process %d is gone", parent)
			sig <- syscall.SIGTERM
			return
		}
	}
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (a *app) controlMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/cast", a.logged("ctrl", a.guard(http.MethodPost, a.handleCast)))
	mux.HandleFunc("/play", a.logged("ctrl", a.guard(http.MethodPost, a.simpleCmd("PLAY", func(c *castConn) error { return c.play() }))))
	mux.HandleFunc("/pause", a.logged("ctrl", a.guard(http.MethodPost, a.simpleCmd("PAUSE", func(c *castConn) error { return c.pause() }))))
	mux.HandleFunc("/toggle", a.logged("ctrl", a.guard(http.MethodPost, a.handleToggle)))
	mux.HandleFunc("/stop", a.logged("ctrl", a.guard(http.MethodPost, a.handleStop)))
	mux.HandleFunc("/seek", a.logged("ctrl", a.guard(http.MethodPost, a.handleSeek)))
	mux.HandleFunc("/devices", a.logged("ctrl", a.guard(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		casting := a.cast != nil
		a.mu.Unlock()
		writeJSON(w, map[string]any{"devices": a.discovery.list(), "casting": casting})
	})))
	mux.HandleFunc("/status", a.logged("ctrl", a.guard(http.MethodGet, a.handleStatus)))
	mux.HandleFunc("/", a.logged("ctrl", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	return mux
}

// guard rejects anything that is not the IINA plugin: wrong Host (DNS
// rebinding), any Origin (a browser page), wrong method, or a missing/wrong
// token.
func (a *app) guard(method string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Host != a.controlAddr {
			logWarn("control API: refused request with Host %q", r.Host)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Header.Get("Origin") != "" {
			logWarn("control API: refused browser request from Origin %q", r.Header.Get("Origin"))
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != method {
			w.Header().Set("Allow", method)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		got := r.Header.Get("X-Cast-Token")
		if subtle.ConstantTimeCompare([]byte(got), []byte(a.token)) != 1 {
			logWarn("control API: refused request without a valid token from %s", r.RemoteAddr)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		h(w, r)
	}
}

// respRecorder captures what a handler actually replied so it can be logged.
type respRecorder struct {
	http.ResponseWriter
	status int
	n      int64
	body   bytes.Buffer // only filled for small non-media responses
	record bool
}

func (r *respRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *respRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	if r.record && r.body.Len() < 2048 {
		r.body.Write(b)
	}
	n, err := r.ResponseWriter.Write(b)
	r.n += int64(n)
	return n, err
}

// logged wraps a handler with request/response logging. Every request gets a
// sequence number so its log lines can be matched up. The request path is not
// logged for media requests because it contains the session token.
func (a *app) logged(kind string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := a.reqSeq.Add(1)
		start := time.Now()

		shown := r.URL.Path
		if kind == "media" {
			shown = "/media/…"
		}
		logDebug("[%s#%d] --> %s %s from %s", kind, id, r.Method, shown, r.RemoteAddr)

		rec := &respRecorder{ResponseWriter: w, record: kind == "ctrl"}
		h(rec, r)

		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		logDebug("[%s#%d] <-- %d (%d bytes) in %s", kind, id, rec.status, rec.n, time.Since(start).Round(time.Millisecond))
	}
}

func (a *app) handleMedia(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	src, pl, ct, token, device := a.src, a.plan, a.contentType, a.mediaToken, a.deviceIP
	a.mu.Unlock()
	path := src.location

	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	got := strings.TrimPrefix(r.URL.Path, "/media/")
	wantSubs := strings.HasSuffix(got, "/subs.vtt")
	got = strings.TrimSuffix(got, "/subs.vtt")
	if path == "" || token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
		http.NotFound(w, r)
		return
	}
	remote, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil || remote.Addr().Unmap() != device {
		logWarn("media: refused request from %s (only %s may fetch)", r.RemoteAddr, device)
		http.NotFound(w, r)
		return
	}

	// The receiver loads text tracks, and then the video too, with CORS. The
	// URL is unguessable and only the device's address gets this far, so
	// allowing any origin gives nothing away.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Range, Content-Type, Accept-Encoding")
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if wantSubs {
		a.mu.Lock()
		job := a.subs
		a.mu.Unlock()
		a.serveSubtitles(w, r, job)
		return
	}

	hits := a.mediaHits.Add(1)
	logDebug("media: request #%d from %s (Range %q)", hits, r.RemoteAddr, r.Header.Get("Range"))

	if pl != nil {
		a.serveConverted(w, r, src, pl)
		return
	}

	f, err := os.Open(path)
	if err != nil {
		logError("media: cannot open %q: %v", path, err)
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		logError("media: %q is no longer a regular file", path)
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// ServeContent honors Range requests, which is what lets the device seek.
	http.ServeContent(w, r, "", st.ModTime(), f)
}

type castRequest struct {
	Device string      `json:"device"` // "192.168.1.50" or "192.168.1.50:8009"
	Path   string      `json:"path"`   // absolute path of a local file, or
	URL    string      `json:"url"`    // http(s) URL of a network stream
	Title  string      `json:"title"`  // shown on the device
	Start  float64     `json:"start"`  // position to start at, in seconds
	Aid    float64     `json:"aid"`    // mpv's 1-based audio track id, 0 = default
	Sub    *subRequest `json:"sub"`    // subtitle track to send, optional
}

// parseDevice accepts only a literal private/link-local IP (optionally with a
// port), so the helper cannot be pointed at arbitrary hosts.
func parseDevice(s string) (netip.AddrPort, error) {
	ap, err := netip.ParseAddrPort(s)
	if err != nil {
		ip, err2 := netip.ParseAddr(s)
		if err2 != nil {
			return netip.AddrPort{}, fmt.Errorf("device must be an IP address or IP:port")
		}
		ap = netip.AddrPortFrom(ip, 8009)
	}
	ip := ap.Addr().Unmap()
	ok := ip.IsPrivate() || ip.IsLinkLocalUnicast() || (allowLoopbackDevice && ip.IsLoopback())
	if !ok {
		return netip.AddrPort{}, fmt.Errorf("device %s is not on the local network", ip)
	}
	if ap.Port() == 0 {
		return netip.AddrPort{}, fmt.Errorf("device port must not be 0")
	}
	return netip.AddrPortFrom(ip, ap.Port()), nil
}

// resolveMediaPath returns the real path of a regular media file, or an error.
func resolveMediaPath(p string) (string, error) {
	if !filepath.IsAbs(p) {
		return "", errors.New("path must be absolute")
	}
	real, err := filepath.EvalSymlinks(filepath.Clean(p))
	if err != nil {
		return "", fmt.Errorf("cannot resolve path: %w", err)
	}
	st, err := os.Stat(real)
	if err != nil {
		return "", fmt.Errorf("cannot stat file: %w", err)
	}
	if !st.Mode().IsRegular() {
		return "", errors.New("path is not a regular file")
	}
	if !mediaExtensions[strings.ToLower(filepath.Ext(real))] {
		return "", fmt.Errorf("%q is not a supported media file type", filepath.Ext(real))
	}
	return real, nil
}

func (a *app) handleCast(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		http.Error(w, "cannot read request body", http.StatusBadRequest)
		return
	}
	var req castRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		logError("cast: cannot decode JSON body: %v", err)
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	device, err := parseDevice(req.Device)
	if err != nil {
		logError("cast: %v", err)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var src source
	if req.URL != "" {
		u, err := parseStreamURL(req.URL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		src = source{location: u, isURL: true}
	} else {
		path, err := resolveMediaPath(req.Path)
		if err != nil {
			logError("cast: rejected path: %v", err)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		src = source{location: path}
	}
	if len(req.Title) > 512 {
		req.Title = req.Title[:512]
	}
	if req.Start < 0 {
		req.Start = 0
	}

	// ffmpeg may have been installed since the helper started.
	a.mu.Lock()
	if a.tools == nil {
		a.tools = lookupTools(a.ffmpegOverride)
	}
	a.mu.Unlock()

	// Decide whether the device can play the source as it is.
	var pl *plan
	var probed *probeResult
	contentType := "video/mp4"
	switch {
	case a.tools != nil:
		var err error
		probed, err = a.tools.probe(src)
		if err != nil {
			logError("cast: cannot read the media: %v", err)
			http.Error(w, "cannot read the media", http.StatusUnprocessableEntity)
			return
		}
		pl = decide(src, probed, int(req.Aid))
	case src.isURL:
		http.Error(w, "ffmpeg is required to cast network streams", http.StatusFailedDependency)
		return
	default:
		logWarn("cast: ffmpeg not found, sending the file as it is")
	}
	if pl == nil {
		contentType = directContentType(src.location)
	}

	// Subtitles are optional: if they cannot be sent, cast without them.
	var subsIn source
	var subsSelector, subsNote string
	if req.Sub != nil {
		switch {
		case a.tools == nil:
			subsNote = "ffmpeg is needed for subtitles"
		default:
			var err error
			subsIn, subsSelector, err = resolveSubtitle(req.Sub, src, probed)
			if err != nil {
				logWarn("cast: no subtitles: %v", err)
				subsNote = err.Error()
			}
		}
	}
	// One session at a time: drop whatever was being served before.
	a.stopSession(false)

	logInfo("cast: dialing device %s ...", device)
	conn, err := dialCast(device.String())
	if err != nil {
		logError("cast: dial %s failed: %v", device, err)
		http.Error(w, "cannot connect to device", http.StatusBadGateway)
		return
	}

	bindIP := a.mediaBindIP
	if bindIP == "" {
		bindIP = conn.localIP
	}
	mediaToken, err := randomToken()
	if err != nil {
		conn.Close()
		http.Error(w, "cannot generate session token", http.StatusInternalServerError)
		return
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(bindIP, a.mediaPort))
	if err != nil {
		logError("cast: media server cannot bind %s:%s: %v", bindIP, a.mediaPort, err)
		conn.Close()
		http.Error(w, "cannot start media server", http.StatusInternalServerError)
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/media/", a.logged("media", a.handleMedia))
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logError("media server stopped: %v", err)
		}
	}()
	logInfo("media server listening on %s for device %s only", ln.Addr(), device.Addr())

	a.mu.Lock()
	mediaURL := fmt.Sprintf("http://%s/media/%s", net.JoinHostPort(bindIP, a.mediaPort), mediaToken)
	a.src, a.plan, a.title, a.contentType = src, pl, req.Title, contentType
	a.mediaURL, a.mediaToken, a.deviceIP = mediaURL, mediaToken, device.Addr()
	a.cast, a.mediaSrv = conn, srv
	if subsSelector != "" {
		a.subs = a.tools.startSubtitleJob(subsIn, subsSelector, req.Sub)
	}
	a.mu.Unlock()
	conn.setOnClose(func() { a.endSession(conn) })

	if err := conn.launchAndLoad(a.mediaInfoAt(req.Start)); err != nil {
		logError("cast: launchAndLoad failed: %v", err)
		a.endSession(conn)
		conn.Close()
		http.Error(w, "device refused the media", http.StatusBadGateway)
		return
	}
	logInfo("cast: LOAD accepted")
	a.watchForMediaFetch()

	mode := "direct"
	if pl != nil {
		mode = "convert"
	}
	subs := "none"
	switch {
	case subsSelector != "":
		subs = "on"
	case req.Sub != nil:
		subs = "unavailable"
	}
	writeJSON(w, map[string]any{"ok": true, "mode": mode, "subs": subs, "subsNote": subsNote})
}

// mediaInfoAt describes the current session's media starting at the given
// position. A converted stream cannot be seeked by the device, so the position
// is baked into the URL and ffmpeg starts there.
func (a *app) mediaInfoAt(start float64) mediaInfo {
	a.mu.Lock()
	src, pl, job, tl := a.src, a.plan, a.subs, a.tools
	m := mediaInfo{url: a.mediaURL, contentType: a.contentType, title: a.title, startTime: start}
	a.mu.Unlock()

	offset := 0.0
	if pl != nil {
		m.startTime = 0
		if start > 0 {
			m.url += "?start=" + strconv.FormatFloat(start, 'f', 3, 64)
			offset = start
			if tl != nil {
				// Where the converted stream really begins (see streamStart).
				offset = tl.streamStart(src, pl, start)
			}
		}
		if pl.duration > offset {
			m.duration = pl.duration - offset
		}
	}
	if job != nil {
		base := m.url
		if i := strings.IndexByte(base, '?'); i >= 0 {
			base = base[:i]
		}
		m.subsURL = base + "/subs.vtt?offset=" + strconv.FormatFloat(offset, 'f', 3, 64)
		m.subsName, m.subsLang = job.name, job.lang
		m.subsStyle = job.req.textTrackStyle()
	}
	return m
}

// endSession stops serving media if conn is still the active session.
func (a *app) endSession(conn *castConn) {
	a.mu.Lock()
	if a.cast != conn {
		a.mu.Unlock()
		return
	}
	srv := a.mediaSrv
	a.cast, a.mediaSrv = nil, nil
	a.src, a.plan = source{}, nil
	if a.subs != nil {
		a.subs.cancel()
		a.subs = nil
	}
	a.title, a.contentType, a.mediaURL, a.mediaToken = "", "", "", ""
	a.deviceIP = netip.Addr{}
	if a.convCancel != nil {
		a.convCancel()
		a.convCancel = nil
	}
	a.mu.Unlock()
	if srv != nil {
		srv.Close()
		logInfo("media server stopped")
	}
}

// stopSession ends the active session, if any. With stopDevice set it also
// asks the device to stop playback and quit the receiver app.
func (a *app) stopSession(stopDevice bool) bool {
	a.mu.Lock()
	conn := a.cast
	a.mu.Unlock()
	if conn == nil {
		return false
	}
	if stopDevice {
		if err := conn.stop(); err != nil {
			logWarn("stop: STOP command failed (continuing teardown): %v", err)
		}
		conn.stopReceiver()
	}
	a.endSession(conn)
	conn.Close()
	return true
}

// watchForMediaFetch flags the most common failure mode: the device accepts the
// LOAD but never connects back to our media server (firewall, or a different
// subnet).
func (a *app) watchForMediaFetch() {
	before := a.mediaHits.Load()
	go func() {
		time.Sleep(15 * time.Second)
		if a.mediaHits.Load() == before {
			logWarn("diagnostic: 15s after LOAD the device has still not requested the media — " +
				"check that the macOS firewall allows inbound connections to casthelper.")
		}
	}()
}

func (a *app) simpleCmd(name string, fn func(*castConn) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		conn := a.cast
		a.mu.Unlock()
		if conn == nil {
			http.Error(w, "not casting", http.StatusConflict)
			return
		}
		if err := fn(conn); err != nil {
			logError("%s: command failed: %v", name, err)
			http.Error(w, "command failed", http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}
}

func (a *app) handleSeek(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<12))
	if err != nil {
		http.Error(w, "cannot read request body", http.StatusBadRequest)
		return
	}
	var body struct {
		Time float64 `json:"time"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.Time < 0 {
		http.Error(w, "invalid seek body", http.StatusBadRequest)
		return
	}
	a.mu.Lock()
	converting := a.plan != nil
	a.mu.Unlock()
	if converting {
		// Restart the conversion at the new position.
		a.simpleCmd("SEEK", func(c *castConn) error { return c.load(a.mediaInfoAt(body.Time)) })(w, r)
		return
	}
	a.simpleCmd("SEEK", func(c *castConn) error { return c.seek(body.Time) })(w, r)
}

// handleToggle pauses or resumes depending on what the device last reported,
// so it stays correct when playback was also paused with the TV remote.
func (a *app) handleToggle(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	conn := a.cast
	a.mu.Unlock()
	if conn == nil {
		http.Error(w, "not casting", http.StatusConflict)
		return
	}
	conn.sessMu.Lock()
	paused := conn.playerState == "PAUSED"
	conn.sessMu.Unlock()
	var err error
	if paused {
		err = conn.play()
	} else {
		err = conn.pause()
	}
	if err != nil {
		logError("toggle: command failed: %v", err)
		http.Error(w, "command failed", http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "paused": !paused})
}

func (a *app) handleStop(w http.ResponseWriter, r *http.Request) {
	if !a.stopSession(true) {
		logWarn("stop: no active cast connection")
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleStatus reports whether a session is active — handy when the plugin
// looks connected but nothing is playing.
func (a *app) handleStatus(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	ct, conn := a.contentType, a.cast
	a.mu.Unlock()

	st := map[string]any{
		"contentType": ct,
		"casting":     conn != nil,
		"mediaHits":   a.mediaHits.Load(),
	}
	if conn != nil {
		conn.sessMu.Lock()
		st["playerState"] = conn.playerState
		st["idleReason"] = conn.idleReason
		conn.sessMu.Unlock()
	}
	writeJSON(w, st)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		logError("cannot write JSON response: %v", err)
	}
}
