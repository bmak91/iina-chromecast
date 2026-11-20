import { makeLogger, LOG_DIR } from "./log";

const { utils, http, global } = iina;
const { log, safe } = makeLogger("global");

// The helper ships inside the plugin (bin/casthelper, built from go-casthelper/
// by build-helper.sh). Nothing is downloaded at runtime. A copy you built
// yourself with install-helper.sh takes precedence.
const IDENTIFIER = "com.bmak91.iina-chromecast";
const PLUGINS = "~/Library/Application Support/com.colliderli.iina/plugins";

function findHelper(): string | null {
  const candidates = ["@data/casthelper"];
  // IINA installs a plugin as <identifier>.iinaplugin, or <identifier>-N if
  // that name is taken.
  for (const suffix of ["", "-1", "-2", "-3", "-4", "-5"]) {
    candidates.push(`${PLUGINS}/${IDENTIFIER}${suffix}.iinaplugin/bin/casthelper`);
  }
  for (const c of candidates) {
    if (utils.fileInPath(c)) return utils.resolvePath(c);
  }
  return null;
}

const bin = findHelper();
const CONTROL = "http://127.0.0.1:9092";

// --- Threading and lifetime rules -------------------------------------------
//
// IINA runs network and process callbacks on background threads, and it can
// tear this script's plugin instance down (on update or reload) while such a
// callback is still on its way. A callback that then calls any iina.* API, or
// posts a message to a player window, crashes IINA.
//
// So callbacks that arrive later (http results, the helper's output, the
// helper exiting) only ever store plain values in variables here. Player
// windows poll for them, and everything that touches IINA happens inside
// that poll: on the main thread, called by a player that is certainly alive.

// The helper prints "READY <token>" on stdout once it is listening. Every
// control request must carry that token, so other local processes and web
// pages cannot drive the helper.
let token: string | null = null;
let stdoutBuf = "";
const notes: string[] = []; // things to log at the next safe moment

function onHelperStdout(out: string) {
  if (token) return;
  stdoutBuf = (stdoutBuf + out).slice(-4096);
  const m = stdoutBuf.match(/READY ([0-9a-f]{64})/);
  if (m) {
    token = m[1];
    stdoutBuf = "";
    notes.push("casthelper is up");
  }
}

function flushNotes() {
  while (notes.length > 0) log(notes.shift());
}

function request(method: "get" | "post", path: string, data?: Record<string, any>) {
  if (!token) return Promise.reject({ statusCode: 0, text: "helper is not running" });
  const options = {
    params: {},
    data: data || {},
    headers: { "Content-Type": "application/json", "X-Cast-Token": token },
  };
  return method === "get" ? http.get(`${CONTROL}${path}`, options) : http.post(`${CONTROL}${path}`, options);
}

function parse(res: any): Record<string, any> {
  try {
    return JSON.parse((res && res.text) || "{}");
  } catch (e) {
    return {};
  }
}

function failureMessage(e: any): string {
  const status = e && e.statusCode;
  if (status === 424) return "ffmpeg is needed to convert this video";
  if (status === 422) return "cannot read this media";
  if (status === 0) return "helper is not running";
  const text = e && typeof e.text === "string" ? e.text.trim() : "";
  return text ? `failed: ${text}` : "failed";
}

// Results waiting for each player window, delivered on its next poll.
const outbox: Record<string, { name: string; data: Record<string, any> }[]> = {};

function queue(player: string | undefined, name: string, data: Record<string, any>) {
  if (!player) return;
  (outbox[player] = outbox[player] || []).push({ name, data });
}

// The device list is refreshed in the background; a poll gets the latest copy.
let devices: Record<string, any> = { ok: false };
let refreshing = false;

function refreshDevices() {
  if (refreshing) return;
  if (!token) {
    devices = { ok: false };
    return;
  }
  refreshing = true;
  request("get", "/devices")
    .then((res) => {
      const body = parse(res);
      devices = {
        ok: true,
        devices: Array.isArray(body.devices) ? body.devices : [],
        casting: body.casting === true,
      };
      refreshing = false;
    })
    .catch(() => {
      devices = { ok: false };
      refreshing = false;
    });
}

// A player window polls about once a second. Everything it is owed is handed
// over right here, synchronously.
global.onMessage(
  "cast:poll",
  safe("cast:poll", (d: any, player?: string) => {
    if (!player) return;
    flushNotes();
    const waiting = outbox[player];
    if (waiting && waiting.length > 0) {
      outbox[player] = [];
      for (const m of waiting) global.postMessage(player, m.name, m.data);
    }
    if (d && d.devices) {
      global.postMessage(player, "cast:devices:list", devices);
      refreshDevices();
    }
  })
);

global.onMessage(
  "cast:load",
  safe("cast:load", (d: any, player?: string) => {
    log("cast request from player", player, { device: d.device, path: d.path, url: d.url, start: d.start });
    request("post", "/cast", d)
      .then((res) => {
        const body = parse(res);
        let message = body.mode === "convert" ? "casting (converting on the fly)" : "casting";
        if (body.subs === "on") message += ", with subtitles";
        if (body.subs === "unavailable") {
          message += `, without subtitles (${body.subsNote || "not supported"})`;
        }
        queue(player, "cast:result", { ok: true, message, detail: body });
      })
      .catch((e) => {
        queue(player, "cast:result", {
          ok: false,
          message: failureMessage(e),
          needsFfmpeg: !!e && e.statusCode === 424,
          detail: e,
        });
      });
  })
);

global.onMessage(
  "cast:toggle",
  safe("cast:toggle", (_d: any, player?: string) => {
    request("post", "/toggle")
      .then((res) => queue(player, "cast:toggled", { ok: true, paused: parse(res).paused === true }))
      .catch((e) => queue(player, "cast:toggled", { ok: false, detail: e }));
  })
);

function command(path: string) {
  return safe(path, (d: any) => {
    log("command", path, d || "");
    request("post", path, d && Object.keys(d).length ? d : undefined).catch(() => undefined);
  });
}
global.onMessage("cast:pause", command("/pause"));
global.onMessage("cast:play", command("/play"));
global.onMessage("cast:seek", command("/seek"));
global.onMessage("cast:stop", command("/stop"));

if (!bin) {
  log("casthelper not found. Reinstall the plugin or run ./install-helper.sh.");
} else {
  log("Starting casthelper");
  // macOS tags files IINA downloads as quarantined, and Gatekeeper then refuses
  // to run the helper because it is not notarized by Apple. Clear that tag on
  // our own helper (and nothing else) before starting it.
  utils
    .exec("/usr/bin/xattr", ["-d", "com.apple.quarantine", bin])
    .catch(() => undefined)
    .then(() => startHelper(bin));
}

// Where a manually downloaded ffmpeg may be: the Downloads folder or the
// plugin's data folder.
function ffmpegDirs(): string {
  return [utils.resolvePath("~/Downloads"), utils.resolvePath("@data/")]
    .filter((p) => typeof p === "string" && p.startsWith("/"))
    .join(":");
}

function startHelper(bin: string) {
  utils
    .exec(
      bin,
      [
        "-control", "127.0.0.1:9092",
        "-media", ":8010",
        "-ffmpeg-dirs", ffmpegDirs(),
        // Always-on log next to the plugin's own, readable only by you. The
        // previous run is kept as helper.prev.log; each file stops at 2 MB.
        "-log", utils.resolvePath(`${LOG_DIR}/helper.log`),
        "-v", "3",
        // Lets a helper started after a plugin reload replace the old one.
        "-pidfile", utils.resolvePath("@data/casthelper.pid"),
      ],
      undefined,
      onHelperStdout
    )
    // These run when the helper exits, possibly long after this script's
    // instance is gone: store a note, never call into IINA from here.
    .then((r) => {
      token = null;
      notes.push(`casthelper exited with status ${r.status} ${(r.stderr || "").slice(-800)}`);
    })
    .catch((e) => {
      notes.push(`casthelper failed to start: ${e}`);
    });
}
