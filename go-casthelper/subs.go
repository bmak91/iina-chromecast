package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Subtitles are sent the way Cast expects them: as a separate WebVTT text
// track next to the video. ffmpeg converts the track selected in IINA (a
// stream inside the file, or a separate subtitle file) once per session; the
// result is then served with its timestamps shifted to wherever the video
// stream currently starts.

// subRequest is the subtitle the plugin asks for.
type subRequest struct {
	Path  string  `json:"path"`  // separate subtitle file, or
	URL   string  `json:"url"`   // separate subtitle served over http(s), or
	Index float64 `json:"index"` // stream index of a track inside the media (-1 = none)
	Lang  string  `json:"lang"`
	Title string  `json:"title"`

	// Subtitle settings taken from IINA when casting starts.
	Delay       float64 `json:"delay"`       // seconds; positive shows subtitles later
	Scale       float64 `json:"scale"`       // size multiplier, 1 = normal
	Pos         float64 `json:"pos"`         // vertical position in percent, 100 = bottom
	Color       string  `json:"color"`       // text colour, #RRGGBBAA
	BorderColor string  `json:"borderColor"` // outline colour, #RRGGBBAA
	Font        string  `json:"font"`
	Bold        bool    `json:"bold"`
	Italic      bool    `json:"italic"`
}

var colorRE = regexp.MustCompile(`^#[0-9A-Fa-f]{8}$`)

// textTrackStyle turns IINA's subtitle look into the style Cast understands.
// The defaults mirror the player: white text with a black outline and no box.
func (r *subRequest) textTrackStyle() map[string]any {
	style := map[string]any{
		"backgroundColor": "#00000000",
		"foregroundColor": "#FFFFFFFF",
		"edgeType":        "OUTLINE",
		"edgeColor":       "#000000FF",
		"windowType":      "NONE",
		"fontScale":       1.0,
	}
	if r.Scale >= 0.25 && r.Scale <= 4 {
		style["fontScale"] = r.Scale
	}
	if colorRE.MatchString(r.Color) {
		style["foregroundColor"] = strings.ToUpper(r.Color)
	}
	if colorRE.MatchString(r.BorderColor) {
		style["edgeColor"] = strings.ToUpper(r.BorderColor)
	}
	if f := cleanText(r.Font); f != "" {
		style["fontFamily"] = f
		style["fontGenericFamily"] = "SANS_SERIF"
	}
	switch {
	case r.Bold && r.Italic:
		style["fontStyle"] = "BOLD_ITALIC"
	case r.Bold:
		style["fontStyle"] = "BOLD"
	case r.Italic:
		style["fontStyle"] = "ITALIC"
	}
	return style
}

// linePercent is where cues are placed vertically, or -1 for the default
// (bottom). IINA's position is the bottom edge of the text; a cue's line
// setting is its top edge, so leave room for about two lines.
func (r *subRequest) linePercent() int {
	if r.Pos <= 0 || r.Pos >= 100 {
		return -1
	}
	p := int(r.Pos) - 10
	if p < 0 {
		p = 0
	}
	return p
}

var subtitleExtensions = map[string]bool{
	".srt": true, ".ass": true, ".ssa": true, ".vtt": true, ".sub": true, ".smi": true,
}

// Picture-based subtitles cannot become text.
var bitmapSubtitles = map[string]bool{
	"hdmv_pgs_subtitle": true, "dvd_subtitle": true, "dvb_subtitle": true, "xsub": true, "dvb_teletext": true,
}

const maxSubtitleBytes = 8 << 20

// subtitleJob is one conversion to WebVTT, running in the background.
type subtitleJob struct {
	done   chan struct{}
	vtt    []byte
	err    error
	cancel context.CancelFunc
	name   string
	lang   string
	req    subRequest
}

// resolveSubtitle validates the request against the probed media and returns
// the ffmpeg input and stream selector to convert, or an error explaining why
// the subtitles cannot be sent.
func resolveSubtitle(req *subRequest, media source, probed *probeResult) (in source, selector string, err error) {
	switch {
	case req.URL != "":
		u, err := parseStreamURL(req.URL)
		if err != nil {
			return source{}, "", err
		}
		return source{location: u, isURL: true}, "0:s:0", nil
	case req.Path != "":
		if !filepath.IsAbs(req.Path) {
			return source{}, "", errors.New("subtitle path must be absolute")
		}
		real, err := filepath.EvalSymlinks(filepath.Clean(req.Path))
		if err != nil {
			return source{}, "", fmt.Errorf("cannot resolve subtitle path: %w", err)
		}
		st, err := os.Stat(real)
		if err != nil || !st.Mode().IsRegular() {
			return source{}, "", errors.New("subtitle path is not a regular file")
		}
		if !subtitleExtensions[strings.ToLower(filepath.Ext(real))] {
			return source{}, "", fmt.Errorf("%q is not a supported subtitle file type", filepath.Ext(real))
		}
		if st.Size() > maxSubtitleBytes {
			return source{}, "", errors.New("subtitle file is too large")
		}
		return source{location: real}, "0:s:0", nil
	default:
		idx := int(req.Index)
		if probed == nil || req.Index < 0 || float64(idx) != req.Index {
			return source{}, "", errors.New("no subtitle track given")
		}
		for _, s := range probed.Streams {
			if s.Index != idx {
				continue
			}
			if s.CodecType != "subtitle" {
				break
			}
			if bitmapSubtitles[s.CodecName] {
				return source{}, "", errors.New("picture-based subtitles cannot be sent as text")
			}
			return media, "0:" + strconv.Itoa(idx), nil
		}
		return source{}, "", errors.New("the selected subtitle track was not found in the file")
	}
}

// startSubtitleJob converts the track to WebVTT in the background.
func (t *tools) startSubtitleJob(in source, selector string, req *subRequest) *subtitleJob {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	job := &subtitleJob{done: make(chan struct{}), cancel: cancel, name: cleanText(req.Title), lang: cleanText(req.Lang), req: *req}
	if job.name == "" {
		job.name = "Subtitles"
	}
	go func() {
		defer close(job.done)
		defer cancel()
		cmd := exec.CommandContext(ctx, t.ffmpeg,
			"-hide_banner", "-loglevel", "error", "-nostdin",
			"-protocol_whitelist", protocolWhitelist(in.isURL),
			"-i", in.location,
			"-map", selector, "-vn", "-an", "-dn",
			"-f", "webvtt", "pipe:1")
		var out, stderr bytes.Buffer
		cmd.Stdout = &limitedWriter{w: &out, n: maxSubtitleBytes}
		cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
		start := time.Now()
		if err := cmd.Run(); err != nil {
			job.err = fmt.Errorf("ffmpeg: %v: %s", err, truncate(stderr.String(), 300))
			logError("subtitles: conversion failed: %v", job.err)
			return
		}
		if !bytes.HasPrefix(bytes.TrimLeft(out.Bytes(), "\xef\xbb\xbf \r\n"), []byte("WEBVTT")) {
			job.err = errors.New("conversion produced no WebVTT")
			logError("subtitles: %v", job.err)
			return
		}
		job.vtt = out.Bytes()
		logInfo("subtitles: ready (%d bytes) after %s", len(job.vtt), time.Since(start).Round(time.Millisecond))
	}()
	return job
}

var vttTimeRE = regexp.MustCompile(`^\s*((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})(.*)$`)

func parseVTTTime(s string) float64 {
	parts := strings.Split(s, ":")
	var sec float64
	for _, p := range parts {
		v, _ := strconv.ParseFloat(p, 64)
		sec = sec*60 + v
	}
	return sec
}

func formatVTTTime(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	ms := int64(sec*1000 + 0.5)
	return fmt.Sprintf("%02d:%02d:%02d.%03d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000)
}

// shiftVTT moves every cue by shift seconds (negative = earlier), drops cues
// that end before zero, and optionally places cues at a vertical position.
// It is used when the video stream starts mid-file and to apply IINA's
// subtitle delay and position.
func shiftVTT(vtt []byte, shift float64, linePercent int) []byte {
	if shift == 0 && linePercent < 0 {
		return vtt
	}
	text := strings.ReplaceAll(string(vtt), "\r\n", "\n")
	blocks := strings.Split(text, "\n\n")
	var out []string
	for i, b := range blocks {
		lines := strings.Split(b, "\n")
		timing := -1
		for j, l := range lines {
			if strings.Contains(l, "-->") {
				timing = j
				break
			}
		}
		if timing < 0 {
			if i == 0 || strings.HasPrefix(b, "NOTE") || strings.HasPrefix(b, "STYLE") || strings.HasPrefix(b, "REGION") {
				out = append(out, b)
			}
			continue
		}
		m := vttTimeRE.FindStringSubmatch(lines[timing])
		if m == nil {
			continue
		}
		start, end := parseVTTTime(m[1])+shift, parseVTTTime(m[2])+shift
		if end <= 0 {
			continue
		}
		settings := m[3]
		if linePercent >= 0 && !strings.Contains(settings, "line:") {
			settings += fmt.Sprintf(" line:%d%%", linePercent)
		}
		lines[timing] = formatVTTTime(start) + " --> " + formatVTTTime(end) + settings
		out = append(out, strings.Join(lines, "\n"))
	}
	return []byte(strings.Join(out, "\n\n") + "\n")
}

// serveSubtitles answers the device's request for the text track. It waits
// for the conversion, which can take a while for a track inside a large file.
func (a *app) serveSubtitles(w http.ResponseWriter, r *http.Request, job *subtitleJob) {
	if job == nil {
		http.NotFound(w, r)
		return
	}
	select {
	case <-job.done:
	case <-r.Context().Done():
		return
	case <-time.After(10 * time.Minute):
		http.Error(w, "subtitles are not ready", http.StatusServiceUnavailable)
		return
	}
	if job.err != nil {
		http.NotFound(w, r)
		return
	}
	offset, _ := strconv.ParseFloat(r.URL.Query().Get("offset"), 64)
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	delay := job.req.Delay
	if delay < -600 || delay > 600 {
		delay = 0
	}
	w.Write(shiftVTT(job.vtt, delay-offset, job.req.linePercent()))
}

// streamStart returns the source time that becomes time zero of a converted
// stream asked to start at `start`. Subtitles are shifted by exactly this.
//
// A re-encoded stream begins at the requested position. A stream with copied
// video begins wherever the container seek lands: on the keyframe at or before
// the position, and usually a little earlier still, because the audio packets
// stored just ahead of that keyframe are kept and the muxer moves the video
// back by its B-frame delay. ffprobe performs the same seek, so the first
// packets it returns show where that is.
func (t *tools) streamStart(src source, p *plan, start float64) float64 {
	if start <= 0 || p == nil || !p.hasVideo || !p.copyVideo || t.ffprobe == "" {
		return start
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, t.ffprobe,
		"-v", "error",
		"-protocol_whitelist", protocolWhitelist(src.isURL),
		"-read_intervals", strconv.FormatFloat(start, 'f', 3, 64)+"%+#60",
		"-show_entries", "packet=stream_index,pts_time,dts_time",
		"-of", "csv=p=0",
		"-i", src.location).Output()
	if err != nil {
		return start
	}
	zero, found := start, false
	seenVideo, seenAudio := false, false
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Split(strings.TrimSpace(line), ",")
		if len(f) < 3 {
			continue
		}
		idx, err := strconv.Atoi(f[0])
		pts, err2 := strconv.ParseFloat(f[1], 64)
		if err != nil || err2 != nil {
			continue
		}
		var ts float64
		switch {
		case idx == p.videoIndex && !seenVideo:
			seenVideo = true
			ts = pts - p.reorderDelay
			if dts, err := strconv.ParseFloat(f[2], 64); err == nil && dts <= pts {
				ts = dts
			}
		case idx == p.audioIndex && !seenAudio:
			seenAudio = true
			ts = pts
		default:
			continue
		}
		if !found || ts < zero {
			zero, found = ts, true
		}
	}
	// At the very beginning of a file the result is slightly negative: the
	// stream starts at 0 and the video is shown a B-frame delay later.
	if !seenVideo || zero < -1 || zero > start {
		return start
	}
	return zero
}
