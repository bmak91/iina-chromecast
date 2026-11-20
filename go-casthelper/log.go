package main

import (
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

// Verbosity levels. -v selects the highest level that gets printed.
const (
	lvlError = iota
	lvlWarn
	lvlInfo
	lvlDebug
	lvlTrace
)

var levelNames = map[int]string{
	lvlError: "ERROR",
	lvlWarn:  "WARN ",
	lvlInfo:  "INFO ",
	lvlDebug: "DEBUG",
	lvlTrace: "TRACE",
}

var (
	logger         = log.New(os.Stderr, "", log.LstdFlags|log.Lmicroseconds|log.Lshortfile)
	logLevel int32 = lvlDebug
)

// setupLogging points every log line at stderr and (if possible) a file, so the
// output survives IINA swallowing the helper's stderr. stdout stays clean —
// the plugin reads it looking for "READY".
func setupLogging(path string, level int) {
	atomic.StoreInt32(&logLevel, int32(level))

	w := io.Writer(os.Stderr)
	if path != "" {
		// The log is always on. It is opened for appending and never
		// truncated here: a helper that turns out to be redundant (the port
		// is taken) must not wipe the log of the helper that is doing the
		// work. rotateLog trims it once this helper knows it is the one.
		_ = os.MkdirAll(filepath.Dir(path), 0o700)
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			logger.Printf("[ERROR] cannot open log file %s: %v (stderr only)", path, err)
		} else {
			logFile = &swappableWriter{f: f}
			w = io.MultiWriter(os.Stderr, logFile)
		}
	}
	logger.SetOutput(w)

	// The stdlib logger is used by net/http for its own errors; send it to the
	// same place.
	log.SetOutput(w)
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
}

func logAt(level int, format string, args ...any) {
	if int(atomic.LoadInt32(&logLevel)) < level {
		return
	}
	// calldepth 3: logAt -> logXxx -> caller
	_ = logger.Output(3, "["+levelNames[level]+"] "+fmt.Sprintf(format, args...))
}

func logError(format string, args ...any) { logAt(lvlError, format, args...) }
func logWarn(format string, args ...any)  { logAt(lvlWarn, format, args...) }
func logInfo(format string, args ...any)  { logAt(lvlInfo, format, args...) }
func logDebug(format string, args ...any) { logAt(lvlDebug, format, args...) }
func logTrace(format string, args ...any) { logAt(lvlTrace, format, args...) }

func traceEnabled() bool { return int(atomic.LoadInt32(&logLevel)) >= lvlTrace }

// truncate keeps long JSON payloads (device status blobs run to several KB)
// from drowning the log.
func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + fmt.Sprintf("...(%d bytes total)", len(s))
}

// hexdump renders wire bytes for the protobuf-level trace logging.
func hexdump(b []byte, max int) string {
	if len(b) > max {
		return hex.EncodeToString(b[:max]) + fmt.Sprintf("...(%d bytes total)", len(b))
	}
	return hex.EncodeToString(b)
}

var logFile *swappableWriter

// swappableWriter is the log file; rotateLog can replace the file under it.
type swappableWriter struct {
	mu sync.Mutex
	f  *os.File
}

func (s *swappableWriter) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.f.Write(b)
	return len(b), nil
}

// rotateLog keeps the log bounded: once it passes 2 MB the current file
// becomes <name>.prev<ext> and a new one is started. Only the helper that owns
// the control port calls this, at start and then periodically.
func rotateLog(path string) {
	if logFile == nil || path == "" {
		return
	}
	logFile.mu.Lock()
	defer logFile.mu.Unlock()
	st, err := logFile.f.Stat()
	if err != nil || st.Size() < 2<<20 {
		return
	}
	prev := strings.TrimSuffix(path, filepath.Ext(path)) + ".prev" + filepath.Ext(path)
	if err := os.Rename(path, prev); err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	logFile.f.Close()
	logFile.f = f
}
