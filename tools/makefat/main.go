// makefat stitches single-architecture Mach-O binaries into one universal
// binary, like `lipo -create`, so the helper can be built on any OS.
//
// usage: makefat <output> <input>...
package main

import (
	"debug/macho"
	"encoding/binary"
	"fmt"
	"os"
)

const (
	fatMagic  = 0xcafebabe
	alignBits = 14 // 16 KiB pages, enough for both arm64 and amd64
)

func main() {
	if len(os.Args) < 4 {
		fmt.Fprintln(os.Stderr, "usage: makefat <output> <input> <input>...")
		os.Exit(2)
	}
	type slice struct {
		cpu, sub uint32
		data     []byte
		offset   uint32
	}
	var slices []slice
	for _, name := range os.Args[2:] {
		f, err := macho.Open(name)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
			os.Exit(1)
		}
		cpu, sub := uint32(f.Cpu), f.SubCpu
		f.Close()
		data, err := os.ReadFile(name)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
			os.Exit(1)
		}
		slices = append(slices, slice{cpu: cpu, sub: sub, data: data})
	}

	const align = 1 << alignBits
	offset := uint32(8 + 20*len(slices))
	for i := range slices {
		offset = (offset + align - 1) &^ (align - 1)
		slices[i].offset = offset
		offset += uint32(len(slices[i].data))
	}

	out := make([]byte, offset)
	binary.BigEndian.PutUint32(out[0:], fatMagic)
	binary.BigEndian.PutUint32(out[4:], uint32(len(slices)))
	for i, s := range slices {
		h := out[8+20*i:]
		binary.BigEndian.PutUint32(h[0:], s.cpu)
		binary.BigEndian.PutUint32(h[4:], s.sub)
		binary.BigEndian.PutUint32(h[8:], s.offset)
		binary.BigEndian.PutUint32(h[12:], uint32(len(s.data)))
		binary.BigEndian.PutUint32(h[16:], alignBits)
		copy(out[s.offset:], s.data)
	}
	if err := os.WriteFile(os.Args[1], out, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
