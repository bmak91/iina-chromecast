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

// The helper prints "READY <token>" on stdout once it is listening. Every
// control request must carry that token, so other local processes and web
// pages cannot drive the helper.
let token: string | null = null;
let stdoutBuf = "";

function onHelperStdout(out: string) {
  if (token) return;
  stdoutBuf = (stdoutBuf + out).slice(-4096);
  const m = stdoutBuf.match(/READY ([0-9a-f]{64})/);
  if (m) {
    token = m[1];
    stdoutBuf = "";
    log("casthelper is up");
  }
}

function post(path: string, data?: Record<string, any>) {
  if (!token) {
    log(`casthelper not ready, dropping ${path}`);
    return Promise.reject({ statusCode: 0, text: "helper is not running" });
  }
  return http.post(`${CONTROL}${path}`, {
    params: {},
    data: data || {},
    headers: {
      "Content-Type": "application/json",
      "X-Cast-Token": token,
    },
  });
}

function quiet(path: string, data?: Record<string, any>) {
  log("command", path, data || "");
  post(path, data).catch((e) => log(`casthelper ${path} failed: ${JSON.stringify(e)}`));
}

function failureMessage(e: any): string {
  const status = e && e.statusCode;
  if (status === 424) return "ffmpeg is needed to convert this video";
  if (status === 422) return "cannot read this media";
  if (status === 0) return "helper is not running";
  const text = e && typeof e.text === "string" ? e.text.trim() : "";
  return text ? `failed: ${text}` : "failed";
}

// Network callbacks run on a background thread. Calling into a player window's
// script from there misbehaves (lookups fail, IINA can hang), so always hop to
// the main thread before posting to a player. Timers fire on the main thread.
function toPlayer(player: string | undefined, name: string, data: Record<string, any>) {
  if (!player) return;
  setTimeout(() => global.postMessage(player, name, data), 0);
}

// Results go back to the player window that asked. (A null target would only
// reach players created by the plugin, not the user's windows.)
function load(d: Record<string, any>, player?: string) {
  log("cast request from player", player, { device: d.device, path: d.path, url: d.url, start: d.start });
  const reply = (r: Record<string, any>) => toPlayer(player, "cast:result", r);
  post("/cast", d)
    .then((res) => {
      let body: Record<string, any> = {};
      try {
        body = JSON.parse((res && res.text) || "{}");
      } catch (e) {}
      let message = body.mode === "convert" ? "casting (converting on the fly)" : "casting";
      if (body.subs === "on") message += ", with subtitles";
      if (body.subs === "unavailable") {
        message += `, without subtitles (${body.subsNote || "not supported"})`;
      }
      log("cast accepted:", body);
      reply({ ok: true, message });
    })
    .catch((e) => {
      log(`casthelper /cast failed: ${JSON.stringify(e)}`);
      reply({ ok: false, message: failureMessage(e), needsFfmpeg: !!e && e.statusCode === 424 });
    });
}

// messages arrive from each player's main entry
global.onMessage("cast:load", safe("cast:load", (d: any, player?: string) => load(d, player)));
global.onMessage("cast:devices", (_d, player) => {
  if (!player) return;
  const reply = (r: Record<string, any>) => toPlayer(player, "cast:devices:list", r);
  if (!token) {
    reply({ ok: false });
    return;
  }
  http
    .get(`${CONTROL}/devices`, { params: {}, headers: { "X-Cast-Token": token }, data: {} })
    .then((res) => {
      const body = JSON.parse((res && res.text) || "{}");
      reply({
        ok: true,
        devices: Array.isArray(body.devices) ? body.devices : [],
        casting: body.casting === true,
      });
    })
    .catch(() => reply({ ok: false }));
});
global.onMessage("cast:toggle", (_d, player) => {
  post("/toggle")
    .then((res) => {
      const paused = /"paused":\s*true/.test((res && res.text) || "");
      toPlayer(player, "cast:toggled", { ok: true, paused });
    })
    .catch((e) => {
      log(`casthelper /toggle failed: ${JSON.stringify(e)}`);
      toPlayer(player, "cast:toggled", { ok: false });
    });
});
global.onMessage("cast:pause", () => quiet("/pause"));
global.onMessage("cast:play", () => quiet("/play"));
global.onMessage("cast:seek", (d) => quiet("/seek", d));
global.onMessage("cast:stop", () => quiet("/stop"));

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
    .then((r) => log(`casthelper exited with status ${r.status}`, (r.stderr || "").slice(-1500)))
    .catch((e) => log(`casthelper failed to start: ${e}`));
}
