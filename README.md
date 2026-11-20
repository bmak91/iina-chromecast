# iina-chromecast (hardened fork)

IINA plugin that casts what you are playing, a local file or a network stream, to a
Chromecast-compatible device (Chromecast, Android TV boxes such as the Freebox Pop
player, …). Media the device cannot play as it is gets converted on the fly.

This is a fork of [dpacmittal/iina-chromecast](https://github.com/dpacmittal/iina-chromecast)
with the security fixes listed below. The helper is covered by Go tests that use a
fake Cast device. The fork has not yet been run on a real IINA + Chromecast setup.

## Install

In IINA: Settings → Plugins → Install from GitHub, and enter `bmak91/iina-chromecast`.
Restart IINA, open a local video, and pick your device under the plugin menu's
*Chromecast* entry.

Conversion needs ffmpeg. If it is missing when you cast something that has to be
converted, the plugin tells you and offers to open the ffmpeg download page. Either:

- run `brew install ffmpeg`, or
- download the macOS build linked from <https://ffmpeg.org/download.html>, unzip it
  and leave the `ffmpeg` file in your Downloads folder. The helper clears the
  macOS quarantine mark on that one file so it can run.

Then cast again; no restart is needed. Without ffmpeg only files the device plays
natively (MP4 with H.264/AAC, WebM, common audio files) can be cast.

The first time you cast, macOS may ask whether `casthelper` may accept incoming
connections: allow it, the TV has to fetch the video from your Mac.

### The bundled helper

`bin/casthelper` is a universal (arm64 + x86_64) binary built from `go-casthelper/`
by `./build-helper.sh` with Go 1.24.7. The build is reproducible, so you can check
that the binary matches the source:

```sh
./build-helper.sh   # needs Go 1.24.7; prints the SHA-256 of bin/casthelper
# expected: 3a28c2681ae1d16da3c19c88e4dd02bebdd386c59893d8bebaa2d3434ce1357d
```

To use a helper you compiled on your own Mac instead, run `./install-helper.sh`.

`dist/` is committed unminified so it can be read; rebuild it with
`npm install --ignore-scripts && npm run build`.

## How it works

- `src/index.ts` (per player window) adds a *Chromecast* entry to the plugin menu and
  keeps it in sync with the helper's device list. *Stop Casting* is enabled only
  while casting.
- Discovery: the helper sends one multicast DNS question for Cast devices and reads
  the answers itself, so devices show up in well under a second. The original
  `/usr/bin/dns-sd` scan (several seconds per run) remains as a fallback.
- `src/global.ts` starts `casthelper` once and relays commands to it.
- `go-casthelper/` speaks the Cast protocol and serves the media to the device over HTTP.

### Conversion

The helper inspects the source with `ffprobe` and picks one of three paths:

| Source | What happens |
|---|---|
| MP4 (H.264 + AAC/MP3), WebM, plain audio files | Served untouched. The device seeks natively. |
| H.264 video in another container or with other audio (typical MKV) | Video is repackaged without re-encoding, audio becomes AAC. Almost no CPU. |
| Anything else (HEVC, 10-bit, AVI, …) | Video is re-encoded to H.264 with the Mac's hardware encoder, at up to 1080p. |

Network streams (http/https URLs opened in IINA) always go through ffmpeg, because
the device cannot reach an address that only exists on your Mac.

HDR video that has to be re-encoded is tone-mapped to standard range when ffmpeg
has the `zscale` and `tonemap` filters (Homebrew's build does).

### Subtitles

The subtitle track selected in IINA when casting starts is sent as a text track:
either a track inside the file or a separately loaded subtitle file. IINA's subtitle
delay, size, vertical position, colours and font are applied as they are at that
moment. Changing them later needs a new cast. Picture-based subtitles (PGS, DVD)
cannot be sent, and styled ASS subtitles arrive as plain text. A track inside a
large file or a network stream can take a while to show up, because the whole
file has to be read to collect it.

Casting starts at IINA's current position and uses the audio track selected in
IINA. Seeking in IINA while converting restarts the conversion at the new position.

## What changed from upstream

| Upstream behaviour | This fork |
|---|---|
| The control API on `127.0.0.1:9092` accepted any request. A web page open in your browser could POST to it and make the helper serve any file your user can read. | Every request needs a random per-launch token (`X-Cast-Token`). Requests with an `Origin` header or an unexpected `Host` are refused. |
| The media server listened on all interfaces for as long as IINA was open and served the last cast file to anyone at `/media`. | The media server only runs during a cast session, is bound to the one address that reaches the device, uses an unguessable per-session URL, and only answers the device's IP. It stops when casting stops, the device ends the session, or IINA exits. |
| Any path and any target host were accepted. | Only regular files with a media extension are served. The device must be a private or link-local IP address. |
| The plugin downloaded an unsigned `casthelper` binary from the upstream repo's *latest* release and ran it at every IINA launch. | Nothing is downloaded at runtime. The helper ships in the repo and its build is reproducible from the source. |
| – | ffmpeg is started with an argument array (no shell) and a protocol whitelist: a network stream cannot make it open local files, and a local file cannot make it reach the network. |
| `allowedDomains: ["*"]`, plus unused permissions. | `allowedDomains: ["127.0.0.1"]`; only `show-osd`, `show-alert`, `network-request`, `file-system`. |
| A debug log of file paths and titles was appended forever to a world-readable file in the temp dir. | Logs go to stderr at info level. `-log` is opt-in and creates the file `0600`. |
| Device replies on the LAN were only read through `dns-sd`. | The helper parses mDNS replies itself: bounds-checked, fuzzed, and it ignores devices that claim a non-private address. |
| No way to stop casting from IINA. | *Stop Casting* menu item. Casting also stops when the window closes. |

## Known limits

- The Cast protocol uses self-signed device certificates, so the TLS connection to the
  device is not authenticated. Someone already able to intercept traffic on your LAN
  could impersonate the TV.
- The video travels to the TV over plain HTTP on your LAN.
- Converted audio is stereo AAC.
- Tone mapping HDR is done in software and may not keep up with 4K sources on
  slower Macs.
- While casting, IINA is the remote: the local player stays paused and muted, and
  play/pause toggles the TV. IINA's own timeline does not follow the TV's position.
