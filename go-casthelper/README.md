# casthelper

A zero-dependency Go helper for the IINA Chromecast plugin. It does the two jobs
IINA's JS plugin sandbox can't: serve the local file to the device over HTTP
(with Range support, so seeking works) and speak the Cast v2 protocol
(TLS + length-prefixed protobuf). Discovery stays in the plugin via macOS's `dns-sd`.

Build and install it with `../install-helper.sh`.

## Control API (loopback only)

On startup the helper prints `READY <token>` on stdout. Every request must send
that token in an `X-Cast-Token` header. Requests carrying an `Origin` header or a
`Host` other than the control address are refused.

| Method | Path    | Body                                   | Purpose                      |
|--------|---------|----------------------------------------|------------------------------|
| POST   | /cast   | `{device, path, contentType, title}`   | connect, launch, LOAD        |
| POST   | /play   | –                                      | resume                       |
| POST   | /pause  | –                                      | pause                        |
| POST   | /seek   | `{time}` (seconds)                     | seek                         |
| POST   | /stop   | –                                      | stop + tear down the session |
| GET    | /status | –                                      | session state                |

`device` must be a private or link-local IP (`ip` or `ip:8009`). `path` must be the
absolute path of a regular media file.

## Media server

Started by `/cast` and stopped when the session ends. It binds to the local
address that reaches the device, serves the one file at `/media/<random token>`,
and answers only the device's IP.

## Not handled

- Codec compatibility / transcoding.
- Subtitles.
