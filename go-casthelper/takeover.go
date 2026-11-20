package main

import (
	"context"
	"net"
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

func takeOverFrom(pidFile, controlAddr string) {
	if pidFile == "" {
		return
	}
	defer os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())), 0o600)

	if portFree(controlAddr) {
		return
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		return
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 1 || pid == os.Getpid() || !isOurPreviousHelper(pid) {
		return
	}
	logInfo("an older helper (pid %d) is still running; asking it to quit", pid)
	_ = syscall.Kill(pid, syscall.SIGTERM)
	for i := 0; i < 40; i++ {
		time.Sleep(100 * time.Millisecond)
		if portFree(controlAddr) {
			return
		}
	}
	logWarn("the older helper did not release the control port")
}

func portFree(addr string) bool {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return false
	}
	ln.Close()
	return true
}

// isOurPreviousHelper reports whether pid is a casthelper with the same parent
// process as this one, so nothing else is ever signalled.
func isOurPreviousHelper(pid int) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/ps", "-o", "ppid=,comm=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	fields := strings.Fields(string(out))
	if len(fields) < 2 {
		return false
	}
	ppid, err := strconv.Atoi(fields[0])
	if err != nil || ppid != os.Getppid() {
		return false
	}
	return strings.HasSuffix(strings.Join(fields[1:], " "), "casthelper")
}
