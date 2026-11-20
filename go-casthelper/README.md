# casthelper

A zero-dependency Go helper for the IINA Chromecast plugin. It does the two jobs
IINA's JS plugin sandbox can't: serve the local file to the device over HTTP
(with Range support, so seeking works) and speak the Cast v2 protocol
(TLS + length-prefixed protobuf). It also finds devices with a multicast DNS query.

Build and install it with `../install-helper.sh`.

## Control API (loopback only)

On startup the helper prints `READY <token>` on stdout. Every request must send
that token in an `X-Cast-Token` header. Requests carrying an `Origin` header or a
`Host` other than the control address are refused.

| Method | Path    | Body                                   | Purpose                      |
|--------|---------|----------------------------------------|------------------------------|
| POST   | /cast   | see below                              | connect, launch, LOAD        |
| POST   | /play   | –                                      | resume                       |
| POST   | /pause  | –                                      | pause                        |
| POST   | /toggle | –                                     | pause or resume, whichever applies |
| POST   | /seek   | `{time}` (seconds)                     | seek                         |
| POST   | /stop   | –                                      | stop + tear down the session |
| GET    | /devices | –                                     | Cast devices found on the LAN |
| GET    | /status | –                                      | session state                |

`/cast` takes `{device, path | url, title, start, aid}`. `device` must be a private
or link-local IP (`ip` or `ip:8009`). `path` must be the absolute path of a regular
media file; `url` must be an http(s) stream. `start` is the position in seconds and
`aid` is mpv's audio track id. The reply says whether the media is served `direct`
or through `convert`.

## Media server

Started by `/cast` and stopped when the session ends. It binds to the local
address that reaches the device, serves at `/media/<random token>`, and answers
only the device's IP. In convert mode the response is the output of ffmpeg
(fragmented MP4, H.264 + AAC); `?start=<seconds>` selects where it begins.

## Not handled

- Subtitles.
