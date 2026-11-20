package main

import (
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Device discovery. Instead of shelling out to dns-sd (which only returns
// after a fixed timeout, once per lookup), the helper sends one multicast DNS
// question for Google Cast devices and reads the answers directly. Devices
// answer within a few hundred milliseconds with everything needed: name,
// model, port and address.
//
// Replies come from anything on the LAN, so they are parsed defensively and
// only private or link-local addresses are accepted.

const castService = "_googlecast._tcp.local."

// mdnsAddr is a variable so tests can point the query at a fake device.
var mdnsAddr = &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}

type device struct {
	Name  string `json:"name"`
	IP    string `json:"ip"`
	Port  int    `json:"port"`
	Model string `json:"model"`
	ID    string `json:"id"`

	seen time.Time
}

type discovery struct {
	mu       sync.Mutex
	devices  map[string]device // keyed by ip:port
	lastScan time.Time
	scanning bool
	done     chan struct{} // closed when the running scan ends
}

const (
	scanWindow   = 1200 * time.Millisecond // how long one scan listens
	scanInterval = 3 * time.Second         // do not scan more often than this
	deviceTTL    = 45 * time.Second        // forget devices not seen for this long
	maxDevices   = 64
)

// list returns the known devices, starting a scan if the last one is stale.
// The first call waits briefly so the caller gets devices right away.
func (d *discovery) list() []device {
	d.mu.Lock()
	if d.devices == nil {
		d.devices = make(map[string]device)
	}
	first := d.lastScan.IsZero()
	if !d.scanning && time.Since(d.lastScan) > scanInterval {
		d.scanning = true
		d.done = make(chan struct{})
		go d.scan(d.done)
	}
	done := d.done
	d.mu.Unlock()

	if first && done != nil {
		select {
		case <-done:
		case <-time.After(600 * time.Millisecond):
		}
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]device, 0, len(d.devices))
	for k, dev := range d.devices {
		if time.Since(dev.seen) > deviceTTL {
			delete(d.devices, k)
			continue
		}
		out = append(out, dev)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].IP < out[j].IP
	})
	return out
}

func (d *discovery) scan(done chan struct{}) {
	defer func() {
		d.mu.Lock()
		d.scanning = false
		d.lastScan = time.Now()
		d.mu.Unlock()
		close(done)
	}()

	found := make(chan device, maxDevices)
	var wg sync.WaitGroup
	for _, local := range scanAddrs() {
		wg.Add(1)
		go func(local net.IP) {
			defer wg.Done()
			if err := queryOnce(local, found); err != nil {
				logDebug("discovery: query from %s failed: %v", local, err)
			}
		}(local)
	}
	go func() { wg.Wait(); close(found) }()

	for dev := range found {
		d.mu.Lock()
		key := net.JoinHostPort(dev.IP, itoa(dev.Port))
		if _, known := d.devices[key]; known || len(d.devices) < maxDevices {
			dev.seen = time.Now()
			d.devices[key] = dev
		}
		d.mu.Unlock()
	}
}

func itoa(n int) string {
	return string(appendInt(nil, n))
}

func appendInt(b []byte, n int) []byte {
	if n >= 10 {
		b = appendInt(b, n/10)
	}
	return append(b, byte('0'+n%10))
}

// scanAddrs returns one local IPv4 address per usable network interface, so
// the question goes out on every network the Mac is on.
func scanAddrs() []net.IP {
	if mdnsAddr.IP.IsLoopback() {
		return []net.IP{net.IPv4(127, 0, 0, 1)}
	}
	var out []net.IP
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagMulticast == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				if ip4 := ipn.IP.To4(); ip4 != nil && (ip4.IsPrivate() || ip4.IsLinkLocalUnicast()) {
					out = append(out, ip4)
					break
				}
			}
		}
	}
	return out
}

// queryOnce sends the question from an ephemeral port on one interface and
// reads replies until the scan window closes. Asking for unicast replies (the
// QU bit) means port 5353, which macOS itself owns, is not needed.
func queryOnce(local net.IP, found chan<- device) error {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: local})
	if err != nil {
		return err
	}
	defer conn.Close()

	if !mdnsAddr.IP.IsLoopback() {
		if raw, err := conn.SyscallConn(); err == nil {
			var ip4 [4]byte
			copy(ip4[:], local.To4())
			_ = raw.Control(func(fd uintptr) {
				_ = syscall.SetsockoptInet4Addr(int(fd), syscall.IPPROTO_IP, syscall.IP_MULTICAST_IF, ip4)
			})
		}
	}

	q := buildQuery()
	deadline := time.Now().Add(scanWindow)
	_ = conn.SetDeadline(deadline)
	if _, err := conn.WriteToUDP(q, mdnsAddr); err != nil {
		return err
	}
	// Ask a second time: UDP is lossy and devices may be waking up.
	resend := time.AfterFunc(scanWindow/3, func() { _, _ = conn.WriteToUDP(q, mdnsAddr) })
	defer resend.Stop()

	buf := make([]byte, 9000)
	for {
		n, from, err := conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				return nil
			}
			return err
		}
		for _, dev := range parseResponse(buf[:n], from.Addr().Unmap()) {
			select {
			case found <- dev:
			default:
			}
		}
	}
}

func buildQuery() []byte {
	q := make([]byte, 12, 64)
	binary.BigEndian.PutUint16(q[4:], 1) // one question
	for _, label := range strings.Split(strings.TrimSuffix(castService, "."), ".") {
		q = append(q, byte(len(label)))
		q = append(q, label...)
	}
	q = append(q, 0)
	q = append(q, 0, 12)      // PTR
	q = append(q, 0x80, 0x01) // class IN, unicast reply requested
	return q
}

type record struct {
	name  string
	typ   uint16
	data  []byte
	start int // offset of data in the packet, for names inside the data
}

// parseResponse extracts Cast devices from one DNS reply. src is the address
// the packet came from, used when the reply carries no A record.
func parseResponse(pkt []byte, src netip.Addr) []device {
	if len(pkt) < 12 || pkt[2]&0x80 == 0 { // too short, or not a response
		return nil
	}
	qd := int(binary.BigEndian.Uint16(pkt[4:]))
	total := int(binary.BigEndian.Uint16(pkt[6:])) + int(binary.BigEndian.Uint16(pkt[8:])) + int(binary.BigEndian.Uint16(pkt[10:]))
	off := 12
	for i := 0; i < qd; i++ {
		_, next, ok := readName(pkt, off)
		if !ok || next+4 > len(pkt) {
			return nil
		}
		off = next + 4
	}
	var recs []record
	for i := 0; i < total && i < 256; i++ {
		name, next, ok := readName(pkt, off)
		if !ok || next+10 > len(pkt) {
			break
		}
		typ := binary.BigEndian.Uint16(pkt[next:])
		rdlen := int(binary.BigEndian.Uint16(pkt[next+8:]))
		start := next + 10
		if start+rdlen > len(pkt) {
			break
		}
		recs = append(recs, record{name: strings.ToLower(name), typ: typ, data: pkt[start : start+rdlen], start: start})
		off = start + rdlen
	}

	var out []device
	for _, ptr := range recs {
		if ptr.typ != 12 || ptr.name != castService {
			continue
		}
		instance, _, ok := readName(pkt, ptr.start)
		if !ok {
			continue
		}
		instance = strings.ToLower(instance)
		dev := device{Port: 8009}
		target := ""
		for _, r := range recs {
			if r.name != instance {
				continue
			}
			switch r.typ {
			case 33: // SRV: priority, weight, port, target
				if len(r.data) >= 7 {
					dev.Port = int(binary.BigEndian.Uint16(r.data[4:]))
					if t, _, ok := readName(pkt, r.start+6); ok {
						target = strings.ToLower(t)
					}
				}
			case 16: // TXT: length-prefixed key=value strings
				for d := r.data; len(d) > 0; {
					l := int(d[0])
					if 1+l > len(d) {
						break
					}
					kv := string(d[1 : 1+l])
					d = d[1+l:]
					switch {
					case strings.HasPrefix(kv, "fn="):
						dev.Name = cleanText(kv[3:])
					case strings.HasPrefix(kv, "md="):
						dev.Model = cleanText(kv[3:])
					case strings.HasPrefix(kv, "id="):
						dev.ID = cleanText(kv[3:])
					}
				}
			}
		}
		ip := src
		for _, r := range recs {
			if r.typ == 1 && len(r.data) == 4 && target != "" && r.name == target {
				ip = netip.AddrFrom4([4]byte(r.data))
			}
		}
		if !ip.Is4() || !(ip.IsPrivate() || ip.IsLinkLocalUnicast() || (allowLoopbackDevice && ip.IsLoopback())) {
			continue
		}
		if dev.Port == 0 {
			continue
		}
		dev.IP = ip.String()
		if dev.Name == "" {
			dev.Name = cleanText(strings.TrimSuffix(strings.TrimSuffix(instance, castService), "."))
		}
		if dev.Name == "" {
			dev.Name = dev.IP
		}
		out = append(out, dev)
	}
	return out
}

// cleanText keeps device-supplied strings short and printable.
func cleanText(s string) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if len(s) > 80 {
		s = strings.ToValidUTF8(s[:80], "")
	}
	return strings.TrimSpace(s)
}

// readName decodes a possibly compressed DNS name starting at off. It returns
// the name with a trailing dot and the offset just past it in the record.
func readName(pkt []byte, off int) (string, int, bool) {
	var sb strings.Builder
	end := -1
	for hops := 0; hops < 32; {
		if off >= len(pkt) {
			return "", 0, false
		}
		l := int(pkt[off])
		switch {
		case l == 0:
			if end < 0 {
				end = off + 1
			}
			return sb.String(), end, true
		case l&0xc0 == 0xc0:
			if off+1 >= len(pkt) {
				return "", 0, false
			}
			if end < 0 {
				end = off + 2
			}
			off = int(binary.BigEndian.Uint16(pkt[off:]) & 0x3fff)
			hops++
		case l&0xc0 != 0:
			return "", 0, false
		default:
			if off+1+l > len(pkt) || sb.Len()+l+1 > 255 {
				return "", 0, false
			}
			sb.Write(pkt[off+1 : off+1+l])
			sb.WriteByte('.')
			off += 1 + l
		}
	}
	return "", 0, false
}
