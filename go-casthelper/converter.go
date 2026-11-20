package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A converter runs one ffmpeg conversion and keeps its output in a temporary
// file, independent of any HTTP connection.
//
// Devices drop the connection when playback is paused for a few seconds and
// reconnect on resume, asking for the stream again from the start or from a
// byte offset. Piping ffmpeg straight into the response cannot survive that:
// the bytes already sent are gone. With the output on disk, every reconnect
// is answered with exactly the bytes the device saw before.
//
// ffmpeg is held back when it gets too far ahead of what the device has
// fetched, so the file only grows as the video is watched.
type converter struct {
	start float64 // source position this conversion begins at

	mu      sync.Mutex
	cond    *sync.Cond
	file    *os.File
	size    int64 // bytes produced so far
	maxRead int64 // furthest byte any request has been given
	done    bool  // ffmpeg has finished (or failed)
	err     error

	cancel context.CancelFunc
}

const (
	convReadAhead = 48 << 20 // how far ffmpeg may run ahead of the device
	convTempGlob  = "casthelper-*.mp4"
)

// removeStaleConversions deletes temp files left behind by a crash.
func removeStaleConversions() {
	matches, _ := filepath.Glob(filepath.Join(os.TempDir(), convTempGlob))
	for _, m := range matches {
		os.Remove(m)
	}
}

func (t *tools) newConverter(src source, p *plan, start float64) (*converter, error) {
	f, err := os.CreateTemp("", convTempGlob) // created 0600
	if err != nil {
		return nil, err
	}
	// Unlink right away: the data stays readable through the open handle and
	// disappears by itself when the helper exits, however it exits.
	os.Remove(f.Name())

	ctx, cancel := context.WithCancel(context.Background())
	c := &converter{start: start, file: f, cancel: cancel}
	c.cond = sync.NewCond(&c.mu)

	cmd := exec.CommandContext(ctx, t.ffmpeg, t.ffmpegArgs(src, p, start)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		f.Close()
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Start(); err != nil {
		cancel()
		f.Close()
		return nil, err
	}
	logInfo("convert: started ffmpeg at %.1fs (video copy=%v)", start, p.copyVideo)

	// Every 15 seconds say how much has been produced and how much of it the
	// device has taken. If the device keeps up with everything produced, the
	// source (or ffmpeg) is the slow side; if a backlog builds up, the network
	// or the device is.
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		var lastSize, lastRead int64
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			c.mu.Lock()
			size, read, done := c.size, c.maxRead, c.done
			c.mu.Unlock()
			logInfo("convert: produced %.1f MB (+%.2f MB/s), device fetched %.1f MB (+%.2f MB/s), backlog %.1f MB",
				float64(size)/1e6, float64(size-lastSize)/15e6, float64(read)/1e6, float64(read-lastRead)/15e6, float64(size-read)/1e6)
			lastSize, lastRead = size, read
			if done && read >= size {
				return
			}
		}
	}()

	go func() {
		buf := make([]byte, 256<<10)
		var runErr error
		for {
			// Wait while far enough ahead of the device.
			c.mu.Lock()
			for c.size-c.maxRead > convReadAhead && ctx.Err() == nil {
				c.cond.Wait()
			}
			c.mu.Unlock()
			if ctx.Err() != nil {
				break
			}
			n, err := stdout.Read(buf)
			if n > 0 {
				c.mu.Lock()
				_, werr := c.file.WriteAt(buf[:n], c.size)
				if werr == nil {
					c.size += int64(n)
				}
				c.cond.Broadcast()
				c.mu.Unlock()
				if werr != nil {
					runErr = werr
					break
				}
			}
			if err != nil {
				if err != io.EOF {
					runErr = err
				}
				break
			}
		}
		waitErr := cmd.Wait()
		if runErr == nil && waitErr != nil && ctx.Err() == nil {
			runErr = fmt.Errorf("%v: %s", waitErr, truncate(stderr.String(), 600))
		}
		c.mu.Lock()
		c.done, c.err = true, runErr
		c.cond.Broadcast()
		c.mu.Unlock()
		if runErr != nil && ctx.Err() == nil {
			logError("convert: ffmpeg failed: %v", runErr)
		} else {
			logInfo("convert: ffmpeg finished")
		}
	}()
	return c, nil
}

// stop ends the conversion and frees the temp file.
func (c *converter) stop() {
	c.cancel()
	c.mu.Lock()
	c.done = true
	c.cond.Broadcast()
	c.mu.Unlock()
	// Give readers a moment to notice before the handle goes away.
	time.AfterFunc(3*time.Second, func() { c.file.Close() })
}

// serve writes the stream from byte offset `from` until it ends or the client
// goes away. It blocks while waiting for ffmpeg to produce more.
func (c *converter) serve(ctx context.Context, w io.Writer, from int64) {
	// Wake the waiting loop when the client disconnects.
	stopWake := context.AfterFunc(ctx, func() {
		c.mu.Lock()
		c.cond.Broadcast()
		c.mu.Unlock()
	})
	defer stopWake()

	buf := make([]byte, 256<<10)
	pos := from
	for {
		c.mu.Lock()
		for pos >= c.size && !c.done && ctx.Err() == nil {
			c.cond.Wait()
		}
		if ctx.Err() != nil || pos >= c.size {
			c.mu.Unlock()
			return
		}
		n := int64(len(buf))
		if c.size-pos < n {
			n = c.size - pos
		}
		_, err := c.file.ReadAt(buf[:n], pos)
		c.mu.Unlock()
		if err != nil {
			return
		}
		if _, err := w.Write(buf[:n]); err != nil {
			return
		}
		pos += n
		c.mu.Lock()
		if pos > c.maxRead {
			c.maxRead = pos
			c.cond.Broadcast() // let ffmpeg continue
		}
		c.mu.Unlock()
	}
}

// parseRangeStart reads the first byte of a "bytes=N-" request, 0 if absent.
func parseRangeStart(h string) (int64, error) {
	if h == "" {
		return 0, nil
	}
	spec, ok := strings.CutPrefix(h, "bytes=")
	if !ok || strings.Contains(spec, ",") {
		return 0, errors.New("unsupported range")
	}
	first, _, _ := strings.Cut(spec, "-")
	if first == "" {
		return 0, errors.New("suffix ranges are not supported")
	}
	n, err := strconv.ParseInt(strings.TrimSpace(first), 10, 64)
	if err != nil || n < 0 {
		return 0, errors.New("bad range")
	}
	return n, nil
}

// serveConverted answers the device's request for the converted stream. A
// request for a new start position (after a seek) replaces the conversion; a
// repeated request for the same one (after a pause) continues it.
func (a *app) serveConverted(w http.ResponseWriter, r *http.Request, src source, p *plan) {
	start := 0.0
	if q := r.URL.Query().Get("start"); q != "" {
		if v, err := strconv.ParseFloat(q, 64); err == nil && v > 0 {
			start = v
		}
	}
	from, err := parseRangeStart(r.Header.Get("Range"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusRequestedRangeNotSatisfiable)
		return
	}

	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodHead {
		w.Header().Set("Accept-Ranges", "none")
		return
	}

	a.mu.Lock()
	conv := a.conv
	if conv == nil || conv.start != start {
		if conv != nil {
			conv.stop()
		}
		conv, err = a.tools.newConverter(src, p, start)
		if err != nil {
			a.conv = nil
			a.mu.Unlock()
			logError("convert: cannot start: %v", err)
			http.Error(w, "cannot start conversion", http.StatusInternalServerError)
			return
		}
		a.conv = conv
	}
	a.mu.Unlock()

	if from > 0 {
		// A resume from the middle. The total length is not known yet.
		conv.mu.Lock()
		beyond := from > conv.size && conv.done
		conv.mu.Unlock()
		if beyond {
			http.Error(w, "range not satisfiable", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/*", from, int64(1)<<50))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.Header().Set("Accept-Ranges", "none")
	}
	logDebug("convert: serving from byte %d", from)
	conv.serve(r.Context(), w, from)
}

type limitedWriter struct {
	w *bytes.Buffer
	n int
}
