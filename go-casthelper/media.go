package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// source is what the user is playing in IINA: a local file or a network stream.
type source struct {
	location string // resolved absolute path, or http(s) URL
	isURL    bool
}

// plan says how the source reaches the device. A nil *plan means the file is
// served as it is (with Range support, so the device seeks natively).
type plan struct {
	copyVideo bool    // H.264 video the device can play: repackage, don't re-encode
	hdr       bool    // HDR video (PQ or HLG) that must be tone-mapped when re-encoded
	hasVideo  bool    // false for audio-only sources
	audio     int     // 0-based index of the audio track to send
	duration  float64 // seconds, 0 if unknown

	videoIndex, audioIndex int     // stream numbers in the source, -1 if none
	reorderDelay           float64 // seconds the muxer delays video to make room for B-frames
}

// tools locates ffmpeg/ffprobe. The helper is started by IINA with an empty
// PATH, so the usual install locations are checked explicitly.
type tools struct {
	ffmpeg, ffprobe string
	videoEncoder    []string
	canToneMap      bool // ffmpeg has the zscale and tonemap filters
}

var toolDirs = []string{"/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"}

// userToolDirs are extra places to look for a manually downloaded ffmpeg, such
// as the user's Downloads folder (set with -ffmpeg-dirs).
var userToolDirs []string

func isExecutableFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0
}

func findTool(name, override string) string {
	if override != "" {
		if st, err := os.Stat(override); err == nil && st.Mode().IsRegular() {
			return override
		}
		return ""
	}
	for _, d := range toolDirs {
		if p := filepath.Join(d, name); isExecutableFile(p) {
			return p
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	for _, d := range userToolDirs {
		p := filepath.Join(d, name)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			allowDownloadedTool(p)
			if isExecutableFile(p) {
				return p
			}
		}
	}
	return ""
}

// allowDownloadedTool prepares an ffmpeg the user downloaded by hand: browsers
// mark downloads as quarantined, and macOS then refuses to run them because
// they are not notarized. The user put the file there for this purpose, so
// clear the mark on that one file and make sure it is executable.
func allowDownloadedTool(p string) {
	if _, err := os.Stat("/usr/bin/xattr"); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, "/usr/bin/xattr", "-d", "com.apple.quarantine", p).Run()
	}
	if st, err := os.Stat(p); err == nil && st.Mode()&0o111 == 0 {
		_ = os.Chmod(p, st.Mode()|0o755)
	}
}

func findTools(ffmpegOverride string) *tools {
	t := &tools{ffmpeg: findTool("ffmpeg", ffmpegOverride)}
	if t.ffmpeg == "" {
		return nil
	}
	// ffprobe is optional: a manual download often has ffmpeg only.
	if p := filepath.Join(filepath.Dir(t.ffmpeg), "ffprobe"); isExecutableFile(p) {
		t.ffprobe = p
	} else if ffmpegOverride == "" {
		t.ffprobe = findTool("ffprobe", "")
	}

	// Prefer the Mac's hardware encoder; fall back to software x264.
	t.videoEncoder = []string{"-c:v", "libx264", "-preset", "veryfast", "-crf", "21"}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, t.ffmpeg, "-hide_banner", "-encoders").Output()
	if err != nil {
		logError("ffmpeg at %s cannot be run: %v", t.ffmpeg, err)
		return nil
	}
	if bytes.Contains(out, []byte("h264_videotoolbox")) {
		t.videoEncoder = []string{"-c:v", "h264_videotoolbox", "-b:v", "8M", "-allow_sw", "1"}
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel2()
	filters, _ := exec.CommandContext(ctx2, t.ffmpeg, "-hide_banner", "-filters").Output()
	t.canToneMap = bytes.Contains(filters, []byte(" zscale ")) && bytes.Contains(filters, []byte(" tonemap "))
	return t
}

// protocolWhitelist limits what ffmpeg may open. A network stream must never
// be able to make ffmpeg read local files (for example through a playlist),
// and a local file must never make it reach out to the network.
func protocolWhitelist(isURL bool) string {
	if isURL {
		return "http,https,tcp,tls,crypto"
	}
	return "file"
}

func parseStreamURL(s string) (string, error) {
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errors.New("url must be an http(s) URL")
	}
	if len(s) > 4096 {
		return "", errors.New("url is too long")
	}
	return u.String(), nil
}

type probeStream struct {
	Index       int    `json:"index"`
	CodecType   string `json:"codec_type"`
	CodecName   string `json:"codec_name"`
	PixFmt      string `json:"pix_fmt"`
	Transfer    string `json:"color_transfer"`
	BFrames     int    `json:"has_b_frames"`
	FrameRate   string `json:"avg_frame_rate"`
	Disposition struct {
		AttachedPic int `json:"attached_pic"`
	} `json:"disposition"`
}

type probeResult struct {
	Streams []probeStream `json:"streams"`
	Format  struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
	} `json:"format"`
}

var (
	inputRE    = regexp.MustCompile(`(?m)^Input #0, (.+), from `)
	durationRE = regexp.MustCompile(`(?m)^\s*Duration: (\d+):(\d+):(\d+(?:\.\d+)?)`)
	streamRE   = regexp.MustCompile(`(?m)^\s*Stream #0:(\d+).*?: (Video|Audio|Subtitle): (\w+)(?:\s*\([^)]*\))*(?:, (\w+))?(.*)$`)
)

// probeWithFFmpeg reads the same facts from the banner `ffmpeg -i` prints,
// for installs that have no ffprobe.
func (t *tools) probeWithFFmpeg(src source) (*probeResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, t.ffmpeg, "-hide_banner", "-nostdin",
		"-protocol_whitelist", protocolWhitelist(src.isURL), "-i", src.location)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	_ = cmd.Run() // always "fails": no output file is given
	out := stderr.String()

	var r probeResult
	m := inputRE.FindStringSubmatch(out)
	if m == nil {
		return nil, fmt.Errorf("ffmpeg: %s", truncate(out, 300))
	}
	r.Format.FormatName = m[1]
	if d := durationRE.FindStringSubmatch(out); d != nil {
		h, _ := strconv.ParseFloat(d[1], 64)
		mi, _ := strconv.ParseFloat(d[2], 64)
		s, _ := strconv.ParseFloat(d[3], 64)
		r.Format.Duration = strconv.FormatFloat(h*3600+mi*60+s, 'f', 3, 64)
	}
	for _, s := range streamRE.FindAllStringSubmatch(out, -1) {
		st := probeStream{CodecType: strings.ToLower(s[2]), CodecName: s[3]}
		st.Index, _ = strconv.Atoi(s[1])
		if st.CodecType == "video" {
			st.PixFmt = s[4]
			for _, tr := range []string{"smpte2084", "arib-std-b67"} {
				if strings.Contains(s[5], tr) {
					st.Transfer = tr
				}
			}
			if strings.Contains(s[5], "(attached pic)") {
				st.Disposition.AttachedPic = 1
			}
		}
		r.Streams = append(r.Streams, st)
	}
	return &r, nil
}

func (t *tools) probe(src source) (*probeResult, error) {
	if t.ffprobe == "" {
		return t.probeWithFFmpeg(src)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, t.ffprobe,
		"-v", "error",
		"-protocol_whitelist", protocolWhitelist(src.isURL),
		"-show_entries", "stream=index,codec_type,codec_name,pix_fmt,color_transfer,has_b_frames,avg_frame_rate:stream_disposition=attached_pic:format=format_name,duration",
		"-of", "json",
		"-i", src.location)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe: %v: %s", err, truncate(stderr.String(), 300))
	}
	var r probeResult
	if err := json.Unmarshal(out, &r); err != nil {
		return nil, fmt.Errorf("ffprobe output: %w", err)
	}
	return &r, nil
}

// decide picks direct play when the Default Media Receiver can take the file
// as it is, and conversion otherwise. aid is mpv's 1-based audio track id
// (0 = unknown).
func decide(src source, r *probeResult, aid int) *plan {
	var video, audio string
	var pixFmt, transfer string
	audioCount := 0
	var audioIndexes []int
	videoIndex, reorderDelay := -1, 0.0
	for _, s := range r.Streams {
		switch s.CodecType {
		case "video":
			if s.Disposition.AttachedPic == 0 && video == "" {
				video, pixFmt, transfer = s.CodecName, s.PixFmt, s.Transfer
				videoIndex = s.Index
				if fps := parseRate(s.FrameRate); fps > 0 && s.BFrames > 0 && s.BFrames <= 16 {
					reorderDelay = float64(s.BFrames) / fps
				}
			}
		case "audio":
			if audio == "" {
				audio = s.CodecName
			}
			audioIndexes = append(audioIndexes, s.Index)
			audioCount++
		}
	}
	p := &plan{hasVideo: video != "", videoIndex: videoIndex, audioIndex: -1, reorderDelay: reorderDelay}
	if d, err := strconv.ParseFloat(r.Format.Duration, 64); err == nil && d > 0 {
		p.duration = d
	}
	if aid >= 1 && aid <= audioCount {
		p.audio = aid - 1
	}
	if p.audio < len(audioIndexes) {
		p.audioIndex = audioIndexes[p.audio]
	}
	h264OK := video == "h264" && (pixFmt == "yuv420p" || pixFmt == "yuvj420p")
	p.copyVideo = h264OK
	p.hdr = transfer == "smpte2084" || transfer == "arib-std-b67"

	if src.isURL || p.audio != 0 {
		return p
	}
	ext := strings.ToLower(filepath.Ext(src.location))
	format := r.Format.FormatName
	switch {
	case strings.Contains(format, "mp4") && (ext == ".mp4" || ext == ".m4v" || ext == ".mov"):
		if h264OK && (audio == "" || audio == "aac" || audio == "mp3") {
			return nil
		}
	case ext == ".webm":
		if (video == "vp8" || video == "vp9") && (audio == "" || audio == "vorbis" || audio == "opus") {
			return nil
		}
	case !p.hasVideo && directAudio[ext] != "":
		return nil
	}
	return p
}

// parseRate reads a frame rate such as "24000/1001".
func parseRate(s string) float64 {
	num, den, ok := strings.Cut(s, "/")
	n, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0
	}
	if !ok {
		return n
	}
	d, err := strconv.ParseFloat(den, 64)
	if err != nil || d == 0 {
		return 0
	}
	return n / d
}

var directAudio = map[string]string{
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
	".flac": "audio/flac", ".wav": "audio/wav", ".ogg": "audio/ogg",
	".oga": "audio/ogg", ".opus": "audio/ogg",
}

// directContentType is the type advertised when a file is served untouched.
func directContentType(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if ct := directAudio[ext]; ct != "" {
		return ct
	}
	if ext == ".webm" {
		return "video/webm"
	}
	return "video/mp4"
}

// ffmpegArgs builds the conversion command: fragmented MP4 (H.264 + AAC) on
// stdout, starting at the given position. Arguments are passed as an array,
// never through a shell.
func (t *tools) ffmpegArgs(src source, p *plan, start float64) []string {
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
	if start > 0 {
		args = append(args, "-ss", strconv.FormatFloat(start, 'f', 3, 64))
		if p.hasVideo && p.copyVideo {
			// Copied video can only start on a keyframe, which may be several
			// seconds before the requested position. Start the audio there
			// too instead of at the exact position.
			args = append(args, "-noaccurate_seek")
		}
	}
	if src.isURL {
		// A paused cast stops reading the source for a while; reconnect
		// instead of treating a dropped source connection as the end.
		args = append(args, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "30")
	}
	args = append(args,
		"-protocol_whitelist", protocolWhitelist(src.isURL),
		"-i", src.location,
		"-sn", "-dn",
		"-map", fmt.Sprintf("0:a:%d?", p.audio),
		"-c:a", "aac", "-ac", "2", "-b:a", "192k",
		// Stretch or pad the audio to follow its timestamps, so glitches in the
		// source do not accumulate into drift against the picture.
		"-af", "aresample=async=1")
	switch {
	case !p.hasVideo:
		args = append(args, "-vn")
	case p.copyVideo:
		args = append(args, "-map", "0:v:0", "-c:v", "copy")
	default:
		args = append(args, "-map", "0:v:0")
		args = append(args, t.videoEncoder...)
		// 8-bit 4:2:0 at up to 1080p is what every Cast device decodes.
		vf := "scale='min(1920,iw)':-2"
		if p.hdr && t.canToneMap {
			// HDR squeezed into SDR without tone mapping looks grey and washed
			// out. Map it to BT.709 and label the result as such.
			vf += ",zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709," +
				"tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
			args = append(args, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709")
		}
		args = append(args, "-vf", vf, "-pix_fmt", "yuv420p")
	}
	return append(args,
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-f", "mp4", "pipe:1")
}

func (l *limitedWriter) Write(b []byte) (int, error) {
	if room := l.n - l.w.Len(); room > 0 {
		if len(b) > room {
			l.w.Write(b[:room])
		} else {
			l.w.Write(b)
		}
	}
	return len(b), nil
}
