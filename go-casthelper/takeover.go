package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// When IINA reloads or updates the plugin it starts a new helper but leaves
// the old one running, still holding the control port. The new helper then
// could not start and casting was dead until IINA was restarted.
//
// Each helper records its process id in a file. A new helper that finds the
// port busy asks the recorded process to quit, after checking that it really
// is a casthelper started by the same IINA, and then takes over.

func takeOverFrom(pidFile, tokenFile, controlAddr string) {
	if pidFile != "" {
		defer os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())), 0o600)
	}
	if portFree(controlAddr) {
		return
	}
	logInfo("the control port is in use; trying to replace the helper that holds it")

	// Preferred: ask it over its own control API, using the token it wrote to
	// the private token file. Only a helper of this plugin can pass that.
	if tokenFile != "" {
		if raw, err := os.ReadFile(tokenFile); err == nil {
			req, _ := http.NewRequest(http.MethodPost, "http://"+controlAddr+"/quit", nil)
			req.Header.Set("X-Cast-Token", strings.TrimSpace(string(raw)))
			client := &http.Client{Timeout: 2 * time.Second}
			if resp, err := client.Do(req); err != nil {
				logWarn("takeover: /quit failed: %v", err)
			} else {
				resp.Body.Close()
				logInfo("takeover: older helper answered /quit with %d", resp.StatusCode)
				if resp.StatusCode == http.StatusOK && waitForPort(controlAddr) {
					return
				}
			}
		}
	}

	// Fallback for helpers that predate /quit: signal the recorded process,
	// but only if it really is a casthelper started by the same IINA.
	if pidFile == "" {
		return
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		logWarn("takeover: no pid file: %v", err)
		return
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 1 || pid == os.Getpid() {
		logWarn("takeover: pid file does not name another process (%q)", strings.TrimSpace(string(raw)))
		return
	}
	if why := notOurPreviousHelper(pid); why != "" {
		logWarn("takeover: leaving pid %d alone: %s", pid, why)
		return
	}
	logInfo("takeover: asking older helper (pid %d) to quit", pid)
	_ = syscall.Kill(pid, syscall.SIGTERM)
	if !waitForPort(controlAddr) {
		logWarn("takeover: the older helper did not release the control port")
	}
}

func waitForPort(addr string) bool {
	for i := 0; i < 40; i++ {
		time.Sleep(100 * time.Millisecond)
		if portFree(addr) {
			return true
		}
	}
	return false
}

func portFree(addr string) bool {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return false
	}
	ln.Close()
	return true
}

// notOurPreviousHelper returns "" if pid is a casthelper with the same parent
// process as this one, and otherwise the reason it is not, so nothing else is
// ever signalled.
func notOurPreviousHelper(pid int) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/ps", "-o", "ppid=,comm=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return "ps failed: " + err.Error()
	}
	fields := strings.Fields(string(out))
	if len(fields) < 2 {
		return "no such process"
	}
	ppid, err := strconv.Atoi(fields[0])
	if err != nil || ppid != os.Getppid() {
		return "it has a different parent (" + fields[0] + ", ours is " + strconv.Itoa(os.Getppid()) + ")"
	}
	if comm := strings.Join(fields[1:], " "); !strings.HasSuffix(comm, "casthelper") {
		return "it is not a casthelper (" + comm + ")"
	}
	return ""
}
