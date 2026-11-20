# iina-chromecast (hardened fork)

IINA plugin that casts the local file you are playing to a Chromecast-compatible
device (Chromecast, Android TV boxes such as the Freebox Pop player, …).

This is a fork of [dpacmittal/iina-chromecast](https://github.com/dpacmittal/iina-chromecast)
with the security fixes listed below. The helper is covered by Go tests that use a
fake Cast device. The fork has not yet been run on a real IINA + Chromecast setup.

## Install

Requires IINA 1.4+ and Go (`brew install go`).

```sh
git clone <this repo> ~/src/iina-chromecast
cd ~/src/iina-chromecast
./install-helper.sh        # tests, builds and installs the helper binary
ln -s "$PWD" ~/Library/Application\ Support/com.colliderli.iina/plugins/iina-chromecast.iinaplugin-dev
```

Restart IINA. The first time you cast, macOS may ask whether `casthelper` may
accept incoming connections: allow it, the TV has to fetch the video from your Mac.

`dist/` is committed unminified so it can be read; rebuild it with
`npm install --ignore-scripts && npm run build`.

## How it works

- `src/index.ts` (per player window) finds devices with `/usr/bin/dns-sd` and adds a
  *Chromecast* entry to the plugin menu.
- `src/global.ts` starts `casthelper` once and relays commands to it.
- `go-casthelper/` speaks the Cast protocol and serves the file to the device over HTTP.

## What changed from upstream

| Upstream behaviour | This fork |
|---|---|
| The control API on `127.0.0.1:9092` accepted any request. A web page open in your browser could POST to it and make the helper serve any file your user can read. | Every request needs a random per-launch token (`X-Cast-Token`). Requests with an `Origin` header or an unexpected `Host` are refused. |
| The media server listened on all interfaces for as long as IINA was open and served the last cast file to anyone at `/media`. | The media server only runs during a cast session, is bound to the one address that reaches the device, uses an unguessable per-session URL, and only answers the device's IP. It stops when casting stops, the device ends the session, or IINA exits. |
| Any path and any target host were accepted. | Only regular files with a media extension are served. The device must be a private or link-local IP address. |
| The plugin downloaded an unsigned `casthelper` binary from the upstream repo's *latest* release and ran it at every IINA launch. | Nothing is downloaded. You build the helper from the source in this repo. |
| `allowedDomains: ["*"]`, plus unused permissions. | `allowedDomains: ["127.0.0.1"]`; only `show-osd`, `network-request`, `file-system`. |
| A debug log of file paths and titles was appended forever to a world-readable file in the temp dir. | Logs go to stderr at info level. `-log` is opt-in and creates the file `0600`. |
| No way to stop casting from IINA. | *Stop Casting* menu item. Casting also stops when the window closes. |

## Known limits

- The Cast protocol uses self-signed device certificates, so the TLS connection to the
  device is not authenticated. Someone already able to intercept traffic on your LAN
  could impersonate the TV.
- The video travels to the TV over plain HTTP on your LAN.
- Only containers and codecs the Default Media Receiver plays work (MP4/WebM with
  H.264/VP8 and AAC/Vorbis are the safe choice). There is no transcoding and no subtitles.
