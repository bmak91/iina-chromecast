(() => {
  // Info.json
  var Info_default = {
    name: "IINA Chromecast",
    identifier: "com.bmak91.iina-chromecast",
    version: "0.5.5",
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
    ghVersion: 18
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
    const safe2 = (what, fn) => {
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
    return { log: log2, safe: safe2 };
  }

  // src/global.ts
  var { utils: utils2, http, global } = iina;
  var { log, safe } = makeLogger("global");
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
  var CONTROL = "http://127.0.0.1:9092";
  var token = null;
  var stdoutBuf = "";
  function onHelperStdout(out) {
    if (token) return;
    stdoutBuf = (stdoutBuf + out).slice(-4096);
    const m = stdoutBuf.match(/READY ([0-9a-f]{64})/);
    if (m) {
      token = m[1];
      stdoutBuf = "";
      log("casthelper is up");
    }
  }
  function post(path, data) {
    if (!token) {
      log(`casthelper not ready, dropping ${path}`);
      return Promise.reject({ statusCode: 0, text: "helper is not running" });
    }
    return http.post(`${CONTROL}${path}`, {
      params: {},
      data: data || {},
      headers: {
        "Content-Type": "application/json",
        "X-Cast-Token": token
      }
    });
  }
  function quiet(path, data) {
    log("command", path, data || "");
    post(path, data).catch((e) => log(`casthelper ${path} failed: ${JSON.stringify(e)}`));
  }
  function failureMessage(e) {
    const status = e && e.statusCode;
    if (status === 424) return "ffmpeg is needed to convert this video";
    if (status === 422) return "cannot read this media";
    if (status === 0) return "helper is not running";
    const text2 = e && typeof e.text === "string" ? e.text.trim() : "";
    return text2 ? `failed: ${text2}` : "failed";
  }
  function toPlayer(player, name, data) {
    if (!player) return;
    setTimeout(() => global.postMessage(player, name, data), 0);
  }
  function load(d, player) {
    log("cast request from player", player, { device: d.device, path: d.path, url: d.url, start: d.start });
    const reply = (r) => toPlayer(player, "cast:result", r);
    post("/cast", d).then((res) => {
      let body = {};
      try {
        body = JSON.parse(res && res.text || "{}");
      } catch (e) {
      }
      let message = body.mode === "convert" ? "casting (converting on the fly)" : "casting";
      if (body.subs === "on") message += ", with subtitles";
      if (body.subs === "unavailable") {
        message += `, without subtitles (${body.subsNote || "not supported"})`;
      }
      log("cast accepted:", body);
      reply({ ok: true, message });
    }).catch((e) => {
      log(`casthelper /cast failed: ${JSON.stringify(e)}`);
      reply({ ok: false, message: failureMessage(e), needsFfmpeg: !!e && e.statusCode === 424 });
    });
  }
  global.onMessage("cast:load", safe("cast:load", (d, player) => load(d, player)));
  global.onMessage("cast:devices", (_d, player) => {
    if (!player) return;
    const reply = (r) => toPlayer(player, "cast:devices:list", r);
    if (!token) {
      reply({ ok: false });
      return;
    }
    http.get(`${CONTROL}/devices`, { params: {}, headers: { "X-Cast-Token": token }, data: {} }).then((res) => {
      const body = JSON.parse(res && res.text || "{}");
      reply({
        ok: true,
        devices: Array.isArray(body.devices) ? body.devices : [],
        casting: body.casting === true
      });
    }).catch(() => reply({ ok: false }));
  });
  global.onMessage("cast:toggle", (_d, player) => {
    post("/toggle").then((res) => {
      const paused = /"paused":\s*true/.test(res && res.text || "");
      toPlayer(player, "cast:toggled", { ok: true, paused });
    }).catch((e) => {
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
    utils2.exec("/usr/bin/xattr", ["-d", "com.apple.quarantine", bin]).catch(() => void 0).then(() => startHelper(bin));
  }
  function ffmpegDirs() {
    return [utils2.resolvePath("~/Downloads"), utils2.resolvePath("@data/")].filter((p) => typeof p === "string" && p.startsWith("/")).join(":");
  }
  function startHelper(bin2) {
    utils2.exec(
      bin2,
      [
        "-control",
        "127.0.0.1:9092",
        "-media",
        ":8010",
        "-ffmpeg-dirs",
        ffmpegDirs(),
        // Always-on log next to the plugin's own, readable only by you. The
        // previous run is kept as helper.prev.log; each file stops at 2 MB.
        "-log",
        utils2.resolvePath(`${LOG_DIR}/helper.log`),
        "-v",
        "3",
        // Lets a helper started after a plugin reload replace the old one.
        "-pidfile",
        utils2.resolvePath("@data/casthelper.pid")
      ],
      void 0,
      onHelperStdout
    ).then((r) => log(`casthelper exited with status ${r.status}`, (r.stderr || "").slice(-1500))).catch((e) => log(`casthelper failed to start: ${e}`));
  }
})();
