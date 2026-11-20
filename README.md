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
converted, the plugin asks whether to install it with Homebrew (`brew install ffmpeg`)
and starts casting when the install is done. Without ffmpeg only files the device
plays natively (MP4 with H.264/AAC, WebM, common audio files) can be cast.

The first time you cast, macOS may ask whether `casthelper` may accept incoming
connections: allow it, the TV has to fetch the video from your Mac.

### The bundled helper

`bin/casthelper` is a universal (arm64 + x86_64) binary built from `go-casthelper/`
by `./build-helper.sh` with Go 1.24.7. The build is reproducible, so you can check
that the binary matches the source:

```sh
./build-helper.sh   # needs Go 1.24.7; prints the SHA-256 of bin/casthelper
# expected: cd23796048a7a891d525dac499d5ebfc2bea9cbd2631a2ed725f0f20f8c29f04
```

To use a helper you compiled on your own Mac instead, run `./install-helper.sh`.

`dist/` is committed unminified so it can be read; rebuild it with
`npm install --ignore-scripts && npm run build`.

## How it works

- `src/index.ts` (per player window) finds devices with `/usr/bin/dns-sd` and adds a
  *Chromecast* entry to the plugin menu.
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
| No way to stop casting from IINA. | *Stop Casting* menu item. Casting also stops when the window closes. |

## Known limits

- The Cast protocol uses self-signed device certificates, so the TLS connection to the
  device is not authenticated. Someone already able to intercept traffic on your LAN
  could impersonate the TV.
- The video travels to the TV over plain HTTP on your LAN.
- No subtitles on the device yet.
- Converted audio is stereo AAC. HDR video is converted without tone mapping, so
  colours can look washed out.
- Un-pausing in IINA to resume the TV also resumes playback on the Mac.
