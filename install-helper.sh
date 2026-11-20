#!/bin/bash
# Build casthelper from the source in go-casthelper/ and put it where the
# plugin looks for it. Nothing is downloaded: the helper has no dependencies
# beyond the Go standard library. Requires Go (brew install go).
set -euo pipefail

cd "$(dirname "$0")/go-casthelper"

IDENTIFIER="com.dpacmittal.iina-chromecast"
DEST="${1:-$HOME/Library/Application Support/com.colliderli.iina/plugins/.data/$IDENTIFIER}"

go vet ./...
go test ./...
go build -trimpath -ldflags "-s -w" -o casthelper .
codesign -s - --force casthelper

mkdir -p "$DEST"
install -m 0755 casthelper "$DEST/casthelper"
rm casthelper
echo "Installed $DEST/casthelper"
