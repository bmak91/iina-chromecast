(() => {
  // Info.json
  var Info_default = {
    name: "IINA Chromecast",
    identifier: "com.bmak91.iina-chromecast",
    version: "0.5.6",
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
    ghVersion: 19
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
  var notes = [];
  function onHelperStdout(out) {
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
  function request(method, path, data) {
    if (!token) return Promise.reject({ statusCode: 0, text: "helper is not running" });
    const options = {
      params: {},
      data: data || {},
      headers: { "Content-Type": "application/json", "X-Cast-Token": token }
    };
    return method === "get" ? http.get(`${CONTROL}${path}`, options) : http.post(`${CONTROL}${path}`, options);
  }
  function parse(res) {
    try {
      return JSON.parse(res && res.text || "{}");
    } catch (e) {
      return {};
    }
  }
  function failureMessage(e) {
    const status = e && e.statusCode;
    if (status === 424) return "ffmpeg is needed to convert this video";
    if (status === 422) return "cannot read this media";
    if (status === 0) return "helper is not running";
    const text2 = e && typeof e.text === "string" ? e.text.trim() : "";
    return text2 ? `failed: ${text2}` : "failed";
  }
  var outbox = {};
  function queue(player, name, data) {
    if (!player) return;
    (outbox[player] = outbox[player] || []).push({ name, data });
  }
  var devices = { ok: false };
  var refreshing = false;
  function refreshDevices() {
    if (refreshing) return;
    if (!token) {
      devices = { ok: false };
      return;
    }
    refreshing = true;
    request("get", "/devices").then((res) => {
      const body = parse(res);
      devices = {
        ok: true,
        devices: Array.isArray(body.devices) ? body.devices : [],
        casting: body.casting === true
      };
      refreshing = false;
    }).catch(() => {
      devices = { ok: false };
      refreshing = false;
    });
  }
  global.onMessage(
    "cast:poll",
    safe("cast:poll", (d, player) => {
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
    safe("cast:load", (d, player) => {
      log("cast request from player", player, { device: d.device, path: d.path, url: d.url, start: d.start });
      request("post", "/cast", d).then((res) => {
        const body = parse(res);
        let message = body.mode === "convert" ? "casting (converting on the fly)" : "casting";
        if (body.subs === "on") message += ", with subtitles";
        if (body.subs === "unavailable") {
          message += `, without subtitles (${body.subsNote || "not supported"})`;
        }
        queue(player, "cast:result", { ok: true, message, detail: body });
      }).catch((e) => {
        queue(player, "cast:result", {
          ok: false,
          message: failureMessage(e),
          needsFfmpeg: !!e && e.statusCode === 424,
          detail: e
        });
      });
    })
  );
  global.onMessage(
    "cast:toggle",
    safe("cast:toggle", (_d, player) => {
      request("post", "/toggle").then((res) => queue(player, "cast:toggled", { ok: true, paused: parse(res).paused === true })).catch((e) => queue(player, "cast:toggled", { ok: false, detail: e }));
    })
  );
  function command(path) {
    return safe(path, (d) => {
      log("command", path, d || "");
      request("post", path, d && Object.keys(d).length ? d : void 0).catch(() => void 0);
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
    ).then((r) => {
      token = null;
      notes.push(`casthelper exited with status ${r.status} ${(r.stderr || "").slice(-800)}`);
    }).catch((e) => {
      notes.push(`casthelper failed to start: ${e}`);
    });
  }
})();
