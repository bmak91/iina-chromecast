#!/bin/bash
# Build the universal (arm64 + x86_64) macOS helper that ships in bin/.
# Works on macOS and Linux; needs only Go. The build is reproducible: with the
# same Go version the output is byte-identical, so `shasum -a 256 bin/casthelper`
# can be compared with the value in README.md.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cd "$root/go-casthelper"
go vet ./...
go test ./...
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=darwin GOARCH=$arch \
    go build -trimpath -ldflags "-s -w -buildid=" -o "$tmp/casthelper-$arch" .
done

cd "$root/tools/makefat"
go run . "$root/bin/casthelper" "$tmp/casthelper-amd64" "$tmp/casthelper-arm64"
chmod 0755 "$root/bin/casthelper"
shasum -a 256 "$root/bin/casthelper" 2>/dev/null || sha256sum "$root/bin/casthelper"
