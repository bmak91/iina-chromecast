(() => {
  // Info.json
  var Info_default = {
    name: "IINA Chromecast",
    identifier: "com.bmak91.iina-chromecast",
    version: "0.6.2",
    description: "Chromecast support for IINA",
    author: {
      name: "Deepak Mittal",
      email: "deepak@dpacmittal.com",
      url: "https://dpacmittal.com"
    },
    entry: "dist/index.js",
    globalEntry: "dist/global.js",
    permissions: [
      "show-osd",
      "show-alert",
      "network-request",
      "file-system"
    ],
    allowedDomains: [
      "127.0.0.1"
    ],
    ghRepo: "bmak91/iina-chromecast",
    ghVersion: 22
  };

  // src/log.ts
  var { utils, file, console: IINAConsole } = iina;
  var LOG_DIR = "~/Library/Logs/IINA Chromecast";
  var LOG_FILE = `${LOG_DIR}/plugin.log`;
  var PREV_FILE = `${LOG_DIR}/plugin.prev.log`;
  var MAX_BYTES = 1 << 20;
  var MAX_PENDING = 500;
  var dirRequested = false;
  var pending = [];
  function ensureDir() {
    if (dirRequested) return;
    dirRequested = true;
    try {
      utils.exec("/bin/mkdir", ["-p", "-m", "700", utils.resolvePath(LOG_DIR)]).catch(() => void 0);
    } catch (e) {
    }
  }
  function flush() {
    if (pending.length === 0) return;
    try {
      if (!file.exists(LOG_FILE)) {
        file.write(LOG_FILE, "");
      }
      const h = file.handle(LOG_FILE, "write");
      if (!h) return;
      h.seekToEnd();
      const size = h.offset();
      h.write(pending.join(""));
      h.close();
      pending = [];
      if (size > MAX_BYTES) {
        utils.exec("/bin/mv", ["-f", utils.resolvePath(LOG_FILE), utils.resolvePath(PREV_FILE)]).catch(() => void 0);
      }
    } catch (e) {
      if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
    }
  }
  function text(v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return `${v.message}
${v.stack || ""}`;
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }
  function makeLogger(tag) {
    ensureDir();
    const log2 = (...args) => {
      const msg = args.map(text).join(" ");
      try {
        IINAConsole.log(msg);
      } catch (e) {
      }
      pending.push(`${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
      flush();
    };
    const safe = (what, fn) => {
      return (...args) => {
        try {
          fn(...args);
        } catch (e) {
          log2(`ERROR in ${what}:`, e);
        }
      };
    };
    log2(`--- started, plugin ${Info_default.version} ---`);
    setTimeout(flush, 1500);
    return { log: log2, safe };
  }

  // src/global.ts
  var { utils: utils2 } = iina;
  var { log } = makeLogger("global");
  var IDENTIFIER = "com.bmak91.iina-chromecast";
  var PLUGINS = "~/Library/Application Support/com.colliderli.iina/plugins";
  function findHelper() {
    const candidates = ["@data/casthelper"];
    for (const suffix of ["", "-1", "-2", "-3", "-4", "-5"]) {
      candidates.push(`${PLUGINS}/${IDENTIFIER}${suffix}.iinaplugin/bin/casthelper`);
    }
    for (const c of candidates) {
      if (utils2.fileInPath(c)) return utils2.resolvePath(c);
    }
    return null;
  }
  var bin = findHelper();
  function ffmpegDirs() {
    return [utils2.resolvePath("~/Downloads"), utils2.resolvePath("@data/")].filter((p) => typeof p === "string" && p.startsWith("/")).join(":");
  }
  function startHelper(bin2) {
    const args = [
      "-control",
      "127.0.0.1:9092",
      "-media",
      ":8010",
      "-ffmpeg-dirs",
      ffmpegDirs(),
      "-tokenfile",
      utils2.resolvePath("@data/casthelper.token"),
      // Always-on log next to the plugin's own, readable only by you. The
      // previous run is kept as helper.prev.log; each file stops at 2 MB.
      "-log",
      utils2.resolvePath(`${LOG_DIR}/helper.log`),
      "-v",
      "3",
      // Lets a helper started after a plugin reload replace the old one.
      "-pidfile",
      utils2.resolvePath("@data/casthelper.pid")
    ];
    const script = '/usr/bin/xattr -d com.apple.quarantine "$0" 2>/dev/null; exec "$0" "$@"';
    utils2.exec("/bin/sh", ["-c", script, bin2, ...args]).then(() => void 0).catch(() => void 0);
  }
  if (!bin) {
    log("casthelper not found. Reinstall the plugin.");
  } else {
    log("Starting casthelper", bin);
    startHelper(bin);
  }
})();
