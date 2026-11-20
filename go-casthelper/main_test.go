package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func newTestApp(t *testing.T) (*app, *httptest.Server) {
	t.Helper()
	a := &app{token: "secret-token", mediaPort: "0"}
	// Tests opt in to ffmpeg by setting a.tools themselves.
	lookupTools = func(string) *tools { return nil }
	t.Cleanup(func() { lookupTools = findTools })
	srv := httptest.NewServer(a.controlMux())
	t.Cleanup(srv.Close)
	a.controlAddr = srv.Listener.Addr().String()
	return a, srv
}

func do(t *testing.T, method, url, body string, hdr map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range hdr {
		if k == "Host" {
			req.Host = v
		} else {
			req.Header.Set(k, v)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestControlAPIRejectsUnauthenticatedCallers(t *testing.T) {
	_, srv := newTestApp(t)
	tok := map[string]string{"X-Cast-Token": "secret-token"}

	cases := []struct {
		name   string
		method string
		hdr    map[string]string
		want   int
	}{
		{"no token (plain CSRF form post)", "POST", nil, http.StatusUnauthorized},
		{"wrong token", "POST", map[string]string{"X-Cast-Token": "nope"}, http.StatusUnauthorized},
		{"browser origin even with token", "POST", map[string]string{"X-Cast-Token": "secret-token", "Origin": "https://evil.example"}, http.StatusForbidden},
		{"dns rebinding host even with token", "POST", map[string]string{"X-Cast-Token": "secret-token", "Host": "evil.example:9092"}, http.StatusForbidden},
		{"GET with token", "GET", tok, http.StatusMethodNotAllowed},
	}
	for _, c := range cases {
		resp := do(t, c.method, srv.URL+"/cast", `{"device":"192.168.1.2","path":"/etc/passwd"}`, c.hdr)
		if resp.StatusCode != c.want {
			t.Errorf("%s: got %d, want %d", c.name, resp.StatusCode, c.want)
		}
	}
	if resp := do(t, "GET", srv.URL+"/status", "", nil); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("/status without token: got %d", resp.StatusCode)
	}
	if resp := do(t, "GET", srv.URL+"/status", "", tok); resp.StatusCode != http.StatusOK {
		t.Errorf("/status with token: got %d", resp.StatusCode)
	}
}

func TestCastRejectsBadInput(t *testing.T) {
	_, srv := newTestApp(t)
	tok := map[string]string{"X-Cast-Token": "secret-token"}
	dir := t.TempDir()
	movie := filepath.Join(dir, "movie.mp4")
	secret := filepath.Join(dir, "id_rsa")
	link := filepath.Join(dir, "link.mp4")
	os.WriteFile(movie, []byte("x"), 0o600)
	os.WriteFile(secret, []byte("x"), 0o600)
	os.Symlink(secret, link)

	bodies := map[string]string{
		"non-media file":       `{"device":"192.168.1.2","path":"` + secret + `"}`,
		"symlink to non-media": `{"device":"192.168.1.2","path":"` + link + `"}`,
		"relative path":        `{"device":"192.168.1.2","path":"movie.mp4"}`,
		"directory":            `{"device":"192.168.1.2","path":"` + dir + `"}`,
		"public device ip":     `{"device":"8.8.8.8","path":"` + movie + `"}`,
		"hostname device":      `{"device":"evil.example:443","path":"` + movie + `"}`,
		"loopback device":      `{"device":"127.0.0.1:22","path":"` + movie + `"}`,
		"non-http stream url":  `{"device":"192.168.1.2","url":"file:///etc/passwd"}`,
		"ftp stream url":       `{"device":"192.168.1.2","url":"ftp://example.com/a.mkv"}`,
		"not json":             `device=1`,
	}
	for name, body := range bodies {
		if resp := do(t, "POST", srv.URL+"/cast", body, tok); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400", name, resp.StatusCode)
		}
	}
}

// fakeDevice is a minimal Cast receiver: it accepts LAUNCH/LOAD and records
// the media URL it was told to play.
func fakeDevice(t *testing.T) (addr string, loaded chan string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	loaded = make(chan string, 8)

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				reply := func(ns string, v map[string]any) {
					b, _ := json.Marshal(v)
					p := encodeCastMessage(castMessage{sourceID: "receiver-0", destID: senderID, namespace: ns, payloadUTF8: string(b)})
					var hdr [4]byte
					binary.BigEndian.PutUint32(hdr[:], uint32(len(p)))
					c.Write(append(hdr[:], p...))
				}
				for {
					var hdr [4]byte
					if _, err := io.ReadFull(c, hdr[:]); err != nil {
						return
					}
					buf := make([]byte, binary.BigEndian.Uint32(hdr[:]))
					if _, err := io.ReadFull(c, buf); err != nil {
						return
					}
					m := decodeCastMessage(buf)
					var p map[string]any
					json.Unmarshal([]byte(m.payloadUTF8), &p)
					switch p["type"] {
					case "LAUNCH", "GET_STATUS":
						reply(nsReceiver, map[string]any{"type": "RECEIVER_STATUS", "requestId": p["requestId"],
							"status": map[string]any{"applications": []any{map[string]any{"appId": defaultReceiverAppID, "transportId": "t-1"}}}})
					case "LOAD":
						loaded <- p["media"].(map[string]any)["contentId"].(string)
						reply(nsMedia, map[string]any{"type": "MEDIA_STATUS", "requestId": p["requestId"],
							"status": []any{map[string]any{"mediaSessionId": 1, "playerState": "PLAYING"}}})
					case "STOP", "PLAY", "PAUSE", "SEEK":
						reply(m.namespace, map[string]any{"type": "MEDIA_STATUS", "requestId": p["requestId"], "status": []any{}})
					}
				}
			}(c)
		}
	}()
	return ln.Addr().String(), loaded
}

func TestCastSessionServesOnlyTheDeviceAndStopsAfterwards(t *testing.T) {
	allowLoopbackDevice = true
	t.Cleanup(func() { allowLoopbackDevice = false })

	a, srv := newTestApp(t)
	tok := map[string]string{"X-Cast-Token": "secret-token"}
	movie := filepath.Join(t.TempDir(), "movie.mp4")
	content := bytes.Repeat([]byte("frame"), 1000)
	os.WriteFile(movie, content, 0o600)

	// Pick a free port for the media server.
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	_, a.mediaPort, _ = net.SplitHostPort(l.Addr().String())
	l.Close()

	device, loaded := fakeDevice(t)
	resp := do(t, "POST", srv.URL+"/cast", `{"device":"`+device+`","path":"`+movie+`","title":"t"}`, tok)
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("cast: got %d: %s", resp.StatusCode, b)
	}
	mediaURL := <-loaded
	if !strings.HasPrefix(mediaURL, "http://127.0.0.1:"+a.mediaPort+"/media/") || len(mediaURL) < 80 {
		t.Fatalf("unexpected media URL %q", mediaURL)
	}

	// The device (127.0.0.1 here) can fetch, with Range support.
	got := do(t, "GET", mediaURL, "", map[string]string{"Range": "bytes=5-9"})
	b, _ := io.ReadAll(got.Body)
	if got.StatusCode != http.StatusPartialContent || string(b) != "frame" {
		t.Errorf("range fetch: got %d %q", got.StatusCode, b)
	}
	// A guessed path does not.
	base := mediaURL[:strings.LastIndex(mediaURL, "/")+1]
	for _, u := range []string{base, base + "deadbeef", strings.TrimSuffix(base, "/")} {
		if r := do(t, "GET", u, "", nil); r.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s: got %d, want 404", u, r.StatusCode)
		}
	}
	// Another machine on the LAN does not, even with the right URL.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", mediaURL, nil)
	req.RemoteAddr = "192.168.1.66:40000"
	a.handleMedia(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("other LAN host: got %d, want 404", rec.Code)
	}

	// After /stop nothing is listening any more.
	if r := do(t, "POST", srv.URL+"/stop", "", tok); r.StatusCode != http.StatusOK {
		t.Fatalf("stop: got %d", r.StatusCode)
	}
	if _, err := http.Get(mediaURL); err == nil {
		t.Errorf("media server still reachable after stop")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.src.location != "" || a.mediaToken != "" || a.cast != nil {
		t.Errorf("session state not cleared after stop")
	}
}

func testTools(t *testing.T) *tools {
	t.Helper()
	tl := findTools("")
	if tl == nil {
		t.Skip("ffmpeg/ffprobe not installed")
	}
	return tl
}

// makeSample writes a short clip with the given codecs using ffmpeg.
func makeSample(t *testing.T, tl *tools, name string, codecArgs ...string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), name)
	args := []string{"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=25",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=4"}
	args = append(args, codecArgs...)
	args = append(args, out)
	if b, err := exec.Command(tl.ffmpeg, args...).CombinedOutput(); err != nil {
		t.Skipf("cannot create sample %s: %v: %s", name, err, b)
	}
	return out
}

// codecsOf fetches a media URL the way the device would and reports what it got.
func codecsOf(t *testing.T, tl *tools, mediaURL string) (format, video, audio string, duration float64) {
	t.Helper()
	resp, err := http.Get(mediaURL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET media: status %d", resp.StatusCode)
	}
	f := filepath.Join(t.TempDir(), "out.mp4")
	data, _ := io.ReadAll(resp.Body)
	os.WriteFile(f, data, 0o600)
	r, err := tl.probe(source{location: f})
	if err != nil {
		t.Fatalf("converted output is not valid media: %v", err)
	}
	for _, s := range r.Streams {
		if s.CodecType == "video" {
			video = s.CodecName
		}
		if s.CodecType == "audio" {
			audio = s.CodecName
		}
	}
	// Fragmented MP4 has no global duration; measure it from the packets.
	out, _ := exec.Command(tl.ffprobe, "-v", "error", "-show_entries", "packet=pts_time", "-select_streams", "a:0", "-of", "csv=p=0", f).Output()
	lines := strings.Fields(strings.TrimSpace(string(out)))
	if len(lines) > 0 {
		duration, _ = strconv.ParseFloat(strings.Trim(lines[len(lines)-1], ","), 64)
	}
	return r.Format.FormatName, video, audio, duration
}

func castForTest(t *testing.T, a *app, srv *httptest.Server, body string) (mode string) {
	t.Helper()
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	_, a.mediaPort, _ = net.SplitHostPort(l.Addr().String())
	l.Close()
	resp := do(t, "POST", srv.URL+"/cast", body, map[string]string{"X-Cast-Token": "secret-token"})
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("cast: got %d: %s", resp.StatusCode, b)
	}
	var out struct{ Mode string }
	json.Unmarshal(b, &out)
	return out.Mode
}

func TestUnsupportedFileIsConvertedOnTheFly(t *testing.T) {
	tl := testTools(t)
	allowLoopbackDevice = true
	t.Cleanup(func() { allowLoopbackDevice = false })
	a, srv := newTestApp(t)
	a.tools = tl
	tok := map[string]string{"X-Cast-Token": "secret-token"}

	// HEVC video + AC-3 audio in MKV: nothing the default receiver plays.
	movie := makeSample(t, tl, "movie.mkv", "-c:v", "libx265", "-preset", "ultrafast", "-c:a", "ac3")
	device, loaded := fakeDevice(t)
	if mode := castForTest(t, a, srv, `{"device":"`+device+`","path":"`+movie+`"}`); mode != "convert" {
		t.Fatalf("mode = %q, want convert", mode)
	}
	format, video, audio, dur := codecsOf(t, tl, <-loaded)
	if !strings.Contains(format, "mp4") || video != "h264" || audio != "aac" {
		t.Errorf("device received %s / %s / %s, want mp4 / h264 / aac", format, video, audio)
	}
	if dur < 3 {
		t.Errorf("converted stream is %.1fs long, want about 4s", dur)
	}

	// Seeking restarts the conversion at the new position.
	if r := do(t, "POST", srv.URL+"/seek", `{"time":2.5}`, tok); r.StatusCode != http.StatusOK {
		t.Fatalf("seek: got %d", r.StatusCode)
	}
	seekURL := <-loaded
	if !strings.Contains(seekURL, "?start=2.500") {
		t.Fatalf("seek did not reload at the new position: %q", seekURL)
	}
	if _, _, _, dur := codecsOf(t, tl, seekURL); dur > 2.5 || dur < 0.5 {
		t.Errorf("stream after seeking to 2.5s is %.1fs long, want about 1.5s", dur)
	}
	do(t, "POST", srv.URL+"/stop", "", tok)
}

func TestH264InMKVIsRepackagedWithoutReencoding(t *testing.T) {
	tl := testTools(t)
	movie := makeSample(t, tl, "movie.mkv", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "ac3")
	src := source{location: movie}
	r, err := tl.probe(src)
	if err != nil {
		t.Fatal(err)
	}
	p := decide(src, r, 0)
	if p == nil || !p.copyVideo {
		t.Fatalf("plan = %+v, want conversion with video copy", p)
	}
	if args := strings.Join(tl.ffmpegArgs(src, p, 0), " "); !strings.Contains(args, "-c:v copy") {
		t.Errorf("ffmpeg args do not copy the video: %s", args)
	}
}

func TestPlainMP4IsServedDirectly(t *testing.T) {
	tl := testTools(t)
	movie := makeSample(t, tl, "movie.mp4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac")
	src := source{location: movie}
	r, err := tl.probe(src)
	if err != nil {
		t.Fatal(err)
	}
	if p := decide(src, r, 0); p != nil {
		t.Errorf("plan = %+v, want direct play", p)
	}
}

func TestNetworkStreamIsConverted(t *testing.T) {
	tl := testTools(t)
	allowLoopbackDevice = true
	t.Cleanup(func() { allowLoopbackDevice = false })
	a, srv := newTestApp(t)
	a.tools = tl

	movie := makeSample(t, tl, "movie.mkv", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "ac3")
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, movie)
	}))
	t.Cleanup(origin.Close)

	device, loaded := fakeDevice(t)
	if mode := castForTest(t, a, srv, `{"device":"`+device+`","url":"`+origin.URL+`/stream"}`); mode != "convert" {
		t.Fatalf("mode = %q, want convert", mode)
	}
	format, video, audio, _ := codecsOf(t, tl, <-loaded)
	if !strings.Contains(format, "mp4") || video != "h264" || audio != "aac" {
		t.Errorf("device received %s / %s / %s, want mp4 / h264 / aac", format, video, audio)
	}
}

func TestNetworkStreamCannotMakeFFmpegReadLocalFiles(t *testing.T) {
	tl := testTools(t)
	a, srv := newTestApp(t)
	a.tools = tl

	local := makeSample(t, tl, "private.mkv", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac")
	// A hostile playlist that points back at a file on this machine.
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		io.WriteString(w, "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:4,\nfile://"+local+"\n#EXT-X-ENDLIST\n")
	}))
	t.Cleanup(origin.Close)

	resp := do(t, "POST", srv.URL+"/cast", `{"device":"192.168.1.2","url":"`+origin.URL+`/x.m3u8"}`, map[string]string{"X-Cast-Token": "secret-token"})
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("playlist pointing at a local file: got %d, want 422", resp.StatusCode)
	}
}

func TestProbeWorksWithoutFFprobe(t *testing.T) {
	tl := testTools(t)
	movie := makeSample(t, tl, "movie.mkv", "-c:v", "libx265", "-preset", "ultrafast", "-c:a", "ac3")
	plain := makeSample(t, tl, "movie.mp4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac")
	noProbe := *tl
	noProbe.ffprobe = ""

	for _, f := range []string{movie, plain} {
		src := source{location: f}
		want, err := tl.probe(src)
		if err != nil {
			t.Fatal(err)
		}
		got, err := noProbe.probe(src)
		if err != nil {
			t.Fatal(err)
		}
		pw, pg := decide(src, want, 0), decide(src, got, 0)
		if (pw == nil) != (pg == nil) {
			t.Fatalf("%s: plan with ffprobe %+v, without %+v", filepath.Base(f), pw, pg)
		}
		if pw != nil && (pw.copyVideo != pg.copyVideo || pw.hasVideo != pg.hasVideo || pg.duration < 3) {
			t.Errorf("%s: plan with ffprobe %+v, without %+v", filepath.Base(f), pw, pg)
		}
	}
}

func TestManuallyDownloadedFFmpegIsFound(t *testing.T) {
	tl := testTools(t)
	dir := t.TempDir()
	data, err := os.ReadFile(tl.ffmpeg)
	if err != nil {
		t.Skip(err)
	}
	// As unzipped from a download: present but not marked executable.
	os.WriteFile(filepath.Join(dir, "ffmpeg"), data, 0o644)

	saved, savedUser := toolDirs, userToolDirs
	toolDirs, userToolDirs = nil, []string{dir}
	t.Setenv("PATH", "")
	t.Cleanup(func() { toolDirs, userToolDirs = saved, savedUser })

	got := findTools("")
	if got == nil || got.ffmpeg != filepath.Join(dir, "ffmpeg") || got.ffprobe != "" {
		t.Fatalf("findTools = %+v, want the downloaded ffmpeg without ffprobe", got)
	}
}

// dnsName encodes a name as DNS labels.
func dnsName(s string) []byte {
	var b []byte
	for _, l := range strings.Split(strings.TrimSuffix(s, "."), ".") {
		b = append(b, byte(len(l)))
		b = append(b, l...)
	}
	return append(b, 0)
}

func dnsRecord(name string, typ uint16, data []byte) []byte {
	b := dnsName(name)
	b = binary.BigEndian.AppendUint16(b, typ)
	b = binary.BigEndian.AppendUint16(b, 1)
	b = binary.BigEndian.AppendUint32(b, 120)
	b = binary.BigEndian.AppendUint16(b, uint16(len(data)))
	return append(b, data...)
}

// castReply builds the mDNS answer a Cast device sends.
func castReply(instance, host, friendly, model string, port uint16, ip [4]byte) []byte {
	pkt := []byte{0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 3}
	full := instance + "._googlecast._tcp.local."
	pkt = append(pkt, dnsRecord("_googlecast._tcp.local.", 12, dnsName(full))...)
	txt := []byte{}
	for _, kv := range []string{"id=abc123", "md=" + model, "fn=" + friendly} {
		txt = append(txt, byte(len(kv)))
		txt = append(txt, kv...)
	}
	pkt = append(pkt, dnsRecord(full, 16, txt)...)
	srv := binary.BigEndian.AppendUint16([]byte{0, 0, 0, 0}, port)
	pkt = append(pkt, dnsRecord(full, 33, append(srv, dnsName(host)...))...)
	pkt = append(pkt, dnsRecord(host, 1, ip[:])...)
	return pkt
}

func TestParseCastReply(t *testing.T) {
	pkt := castReply("Freebox-Player-POP-1234", "fbx.local.", "Freebox Player POP", "Freebox Player POP", 8009, [4]byte{192, 168, 1, 50})
	devs := parseResponse(pkt, netip.MustParseAddr("192.168.1.50"))
	if len(devs) != 1 || devs[0].Name != "Freebox Player POP" || devs[0].IP != "192.168.1.50" || devs[0].Port != 8009 || devs[0].ID != "abc123" {
		t.Fatalf("parsed %+v", devs)
	}
	// A reply that claims a public address is ignored.
	pkt = castReply("x", "x.local.", "Evil", "m", 8009, [4]byte{8, 8, 8, 8})
	if devs := parseResponse(pkt, netip.MustParseAddr("192.168.1.66")); len(devs) != 0 {
		t.Errorf("accepted a device with a public address: %+v", devs)
	}
	// Truncated packets do not panic.
	for i := range pkt {
		parseResponse(pkt[:i], netip.MustParseAddr("192.168.1.50"))
	}
}

func FuzzParseResponse(f *testing.F) {
	f.Add(castReply("a", "h.local.", "Name", "Model", 8009, [4]byte{192, 168, 1, 2}))
	f.Add([]byte{0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 0x0c, 0, 12, 0, 1, 0, 0, 0, 0, 0, 2, 0xc0, 0x0c})
	f.Fuzz(func(t *testing.T, b []byte) {
		parseResponse(b, netip.MustParseAddr("192.168.1.2"))
	})
}

func TestDevicesEndpointFindsADeviceQuickly(t *testing.T) {
	allowLoopbackDevice = true
	t.Cleanup(func() { allowLoopbackDevice = false })

	// A fake device answering the Cast question on loopback.
	responder, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { responder.Close() })
	saved := mdnsAddr
	mdnsAddr = responder.LocalAddr().(*net.UDPAddr)
	t.Cleanup(func() { mdnsAddr = saved })
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := responder.ReadFromUDP(buf)
			if err != nil {
				return
			}
			if !bytes.Contains(buf[:n], []byte("_googlecast")) {
				continue
			}
			responder.WriteToUDP(castReply("tv", "tv.local.", "Living Room TV", "Chromecast", 8009, [4]byte{127, 0, 0, 1}), from)
		}
	}()

	_, srv := newTestApp(t)
	start := time.Now()
	resp := do(t, "GET", srv.URL+"/devices", "", map[string]string{"X-Cast-Token": "secret-token"})
	var out struct{ Devices []device }
	json.NewDecoder(resp.Body).Decode(&out)
	if len(out.Devices) != 1 || out.Devices[0].Name != "Living Room TV" || out.Devices[0].IP != "127.0.0.1" {
		t.Fatalf("devices = %+v", out.Devices)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("first discovery took %s", took)
	}
	if r := do(t, "GET", srv.URL+"/devices", "", nil); r.StatusCode != http.StatusUnauthorized {
		t.Errorf("/devices without token: got %d", r.StatusCode)
	}
}

// firstPTS returns the timestamp of the first real packet of a stream. For
// audio the encoder's priming packet at 0 is skipped.
func firstPTS(t *testing.T, tl *tools, file, stream string) float64 {
	t.Helper()
	out, err := exec.Command(tl.ffprobe, "-v", "error", "-select_streams", stream,
		"-show_entries", "packet=pts_time", "-of", "csv=p=0", file).Output()
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Fields(string(out))
	if len(lines) < 3 {
		t.Fatalf("stream %s has %d packets", stream, len(lines))
	}
	i := 0
	if strings.HasPrefix(stream, "a") {
		i = 1
	}
	v, _ := strconv.ParseFloat(strings.Trim(lines[i], ","), 64)
	return v
}

// Casting from the middle of a file must not shift audio against video. With
// copied video the stream can only start on a keyframe, here up to 10 seconds
// before the requested position, and the audio has to start there as well.
func TestAudioAndVideoStartTogetherAfterSeek(t *testing.T) {
	tl := testTools(t)
	movie := makeLongSample(t, tl)
	src := source{location: movie}
	r, err := tl.probe(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, copyVideo := range []bool{true, false} {
		p := decide(src, r, 0)
		p.copyVideo = copyVideo
		out := filepath.Join(t.TempDir(), "out.mp4")
		args := tl.ffmpegArgs(src, p, 7.3)
		args[len(args)-1] = out
		if b, err := exec.Command(tl.ffmpeg, append([]string{"-y"}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg: %v: %s", err, b)
		}
		v, a := firstPTS(t, tl, out, "v:0"), firstPTS(t, tl, out, "a:0")
		if d := a - v; d > 0.15 || d < -0.15 {
			t.Errorf("copyVideo=%v: audio starts at %.3fs, video at %.3fs", copyVideo, a, v)
		}
	}
}

func makeLongSample(t *testing.T, tl *tools) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "long.mkv")
	args := []string{"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc=duration=20:size=320x240:rate=25",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=20",
		"-c:v", "libx264", "-preset", "ultrafast", "-g", "250", "-bf", "2", "-pix_fmt", "yuv420p", "-c:a", "ac3", out}
	if b, err := exec.Command(tl.ffmpeg, args...).CombinedOutput(); err != nil {
		t.Skipf("cannot create sample: %v: %s", err, b)
	}
	return out
}
