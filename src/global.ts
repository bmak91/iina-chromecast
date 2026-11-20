import { makeLogger, LOG_DIR } from "./log";

const { utils } = iina;
const { log } = makeLogger("global");

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

// This script only starts the helper. Player windows talk to the helper
// directly; there are no messages between them and this script, because in
// IINA a message that crosses plugin instances at the wrong moment (during a
// reload, or from a background thread) crashes the app.
//
// The helper writes its access token to a private file in the plugin's data
// folder, where the player scripts read it.

function ffmpegDirs(): string {
  return [utils.resolvePath("~/Downloads"), utils.resolvePath("@data/")]
    .filter((p) => typeof p === "string" && p.startsWith("/"))
    .join(":");
}

function startHelper(bin: string) {
  const args = [
    "-control", "127.0.0.1:9092",
    "-media", ":8010",
    "-ffmpeg-dirs", ffmpegDirs(),
    "-tokenfile", utils.resolvePath("@data/casthelper.token"),
    // Always-on log next to the plugin's own, readable only by you. The
    // previous run is kept as helper.prev.log; each file stops at 2 MB.
    "-log", utils.resolvePath(`${LOG_DIR}/helper.log`),
    "-v", "3",
    // Lets a helper started after a plugin reload replace the old one.
    "-pidfile", utils.resolvePath("@data/casthelper.pid"),
  ];
  // macOS tags files IINA downloads as quarantined, and Gatekeeper then refuses
  // to run the helper because it is not notarized by Apple. Clear that tag on
  // our own helper (and nothing else), then start it. Both happen in one
  // process so that no callback is needed in between; the helper path and its
  // arguments are passed as parameters, never pasted into the command text.
  const script = '/usr/bin/xattr -d com.apple.quarantine "$0" 2>/dev/null; exec "$0" "$@"';
  utils
    .exec("/bin/sh", ["-c", script, bin, ...args])
    // The helper may exit long after this script's instance is gone, so
    // nothing may be done here. Its own log says why it stopped.
    .then(() => undefined)
    .catch(() => undefined);
}

if (!bin) {
  log("casthelper not found. Reinstall the plugin.");
} else {
  log("Starting casthelper", bin);
  startHelper(bin);
}
