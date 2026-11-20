(() => {
  // Info.json
  var Info_default = {
    name: "IINA Chromecast",
    identifier: "com.bmak91.iina-chromecast",
    version: "0.6.0",
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
    ghVersion: 20
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

  // src/index.ts
  var { utils: utils2, http, file: file2, mpv, core, event: IINAEvent, menu } = iina;
  var { log, safe } = makeLogger("player");
  var CONTROL = "http://127.0.0.1:9092";
  var TOKEN_FILE = "@data/casthelper.token";
  var inbox = [];
  function readToken() {
    try {
      const t = file2.read(TOKEN_FILE, {});
      return typeof t === "string" && /^[0-9a-f]{64}$/.test(t.trim()) ? t.trim() : "";
    } catch (e) {
      return "";
    }
  }
  function ask(kind, method, path, data) {
    const token = readToken();
    if (!token) {
      inbox.push({ kind, ok: false, status: 0, text: "" });
      return;
    }
    const options = {
      params: {},
      data: data || {},
      headers: { "Content-Type": "application/json", "X-Cast-Token": token }
    };
    const p = method === "get" ? http.get(`${CONTROL}${path}`, options) : http.post(`${CONTROL}${path}`, options);
    p.then((res) => {
      inbox.push({ kind, ok: true, status: 200, text: res && res.text || "" });
    }).catch((e) => {
      inbox.push({
        kind,
        ok: false,
        status: e && typeof e.statusCode === "number" && e.statusCode || -1,
        text: e && typeof e.text === "string" && e.text || ""
      });
    });
  }
  function parse(text2) {
    try {
      const v = JSON.parse(text2 || "{}");
      return v && typeof v === "object" ? v : {};
    } catch (e) {
      return {};
    }
  }
  var devices = [];
  var scanned = false;
  var menuKey = "";
  var casting = false;
  var castConfirmed = false;
  var wasMuted = false;
  var lastRequest = null;
  function disabledItem(title) {
    return menu.item(title, null, { enabled: false });
  }
  function rebuildMenu() {
    const key = JSON.stringify([devices, casting, scanned]);
    if (key === menuKey) return;
    menuKey = key;
    const root = menu.item("Chromecast", () => {
    });
    if (devices.length === 0) {
      root.addSubMenuItem(disabledItem(scanned ? "No Devices Found" : "Scanning..."));
    }
    for (const d of devices) {
      root.addSubMenuItem(
        menu.item(
          d.name,
          safe("cast menu item", () => castCurrent(d.address))
        )
      );
    }
    root.addSubMenuItem(menu.separator());
    root.addSubMenuItem(
      casting ? menu.item("Stop Casting", safe("stop menu item", () => stopCasting())) : disabledItem("Stop Casting")
    );
    root.addSubMenuItem(menu.item("Show Logs", () => utils2.open(utils2.resolvePath(LOG_DIR))));
    menu.removeAllItems();
    menu.addItem(root);
    menu.forceUpdate();
  }
  function setDevices(list) {
    const before = JSON.stringify(devices);
    devices = list.filter((d) => d && typeof d.name === "string" && typeof d.address === "string").sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
    if (JSON.stringify(devices) !== before || !scanned) log("devices:", devices);
    scanned = true;
    rebuildMenu();
  }
  var ticks = 0;
  var emptyAnswers = 0;
  function tick() {
    ticks += 1;
    while (inbox.length > 0) {
      const r = inbox.shift();
      if (r.kind === "devices") onDevices(r);
      else if (r.kind === "cast") onCastResult(r);
      else if (r.kind === "toggle") onToggled(r);
      else if (!r.ok) log(`${r.kind} failed:`, r.status, r.text.trim());
    }
    if (ticks <= 6 || ticks % 4 === 0) ask("devices", "get", "/devices");
  }
  function onDevices(r) {
    if (!r.ok) {
      emptyAnswers += 1;
      if (emptyAnswers === 8) {
        log("the helper is not answering:", r.status, r.text.trim());
        setDevices([]);
      }
      return;
    }
    emptyAnswers = 0;
    const body = parse(r.text);
    const list = (Array.isArray(body.devices) ? body.devices : []).map((d) => ({
      name: String(d.name),
      address: `${d.ip}:${d.port}`
    }));
    if (list.length > 0 || ticks > 4) setDevices(list);
    if (body.casting === false && casting && castConfirmed) {
      log("the helper reports the session has ended");
      endCasting();
      core.osd("Chromecast: casting ended");
    }
  }
  function setCasting(on) {
    casting = on;
    rebuildMenu();
  }
  function beginCasting() {
    if (!casting) {
      try {
        wasMuted = mpv.getFlag("mute");
        mpv.set("mute", true);
      } catch (e) {
      }
    }
    castConfirmed = false;
    setCasting(true);
    core.pause();
  }
  function endCasting() {
    if (!casting) return;
    setCasting(false);
    castConfirmed = false;
    try {
      mpv.set("mute", wasMuted);
    } catch (e) {
    }
  }
  function currentSource(url) {
    if (typeof url !== "string" || url === "") return null;
    if (url.startsWith("file://localhost/")) return { path: url.slice("file://localhost".length) };
    if (url.startsWith("file:///")) return { path: url.slice("file://".length) };
    if (url.startsWith("/")) return { path: url };
    if (/^https?:\/\//i.test(url)) return { url };
    return null;
  }
  function tryGet(get, fallback) {
    try {
      const v = get();
      return v === void 0 || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }
  function positive(n) {
    return typeof n === "number" && isFinite(n) && n > 0 ? n : 0;
  }
  function castColor(c) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(c || "");
    return m ? `#${m[2]}${m[1]}` : "";
  }
  function selectedSubtitle() {
    const tracks = tryGet(() => mpv.getNative("track-list"), []);
    if (!Array.isArray(tracks)) return null;
    const t = tracks.find((x) => x && x.type === "sub" && x.selected);
    if (!t) return null;
    const sub = {
      index: -1,
      lang: typeof t.lang === "string" ? t.lang : "",
      title: typeof t.title === "string" ? t.title : "",
      delay: tryGet(() => mpv.getNumber("sub-delay"), 0),
      // IINA's size setting is the font size (default 55); sub-scale multiplies it.
      scale: tryGet(() => mpv.getNumber("sub-scale"), 1) * (tryGet(() => mpv.getNumber("sub-font-size"), 55) / 55),
      pos: tryGet(() => mpv.getNumber("sub-pos"), 100),
      color: castColor(tryGet(() => mpv.getString("sub-color"), "")),
      borderColor: castColor(
        tryGet(() => mpv.getString("sub-border-color"), "") || tryGet(() => mpv.getString("sub-outline-color"), "")
      ),
      font: tryGet(() => mpv.getString("sub-font"), ""),
      bold: tryGet(() => mpv.getFlag("sub-bold"), false),
      italic: tryGet(() => mpv.getFlag("sub-italic"), false)
    };
    if (t.external && typeof t["external-filename"] === "string") {
      const f = t["external-filename"];
      if (/^https?:\/\//i.test(f)) sub.url = f;
      else if (f.startsWith("/")) sub.path = f;
      else return null;
    } else if (typeof t["ff-index"] === "number") {
      sub.index = t["ff-index"];
    } else {
      return null;
    }
    return sub;
  }
  function castCurrent(device) {
    const url = core.status.url;
    const source = currentSource(url);
    if (!source) {
      log(`Cannot cast this source: ${JSON.stringify(url)}`);
      core.osd(url ? "Chromecast: this source cannot be cast" : "Chromecast: no file is open");
      return;
    }
    lastRequest = {
      device,
      ...source,
      title: core.status.title || "IINA",
      start: positive(tryGet(() => mpv.getNumber("time-pos"), 0)),
      aid: positive(tryGet(() => mpv.getNumber("aid"), 0))
    };
    const sub = selectedSubtitle();
    if (sub) lastRequest.sub = sub;
    log("cast request:", lastRequest);
    core.osd("Chromecast: connecting\u2026");
    beginCasting();
    ask("cast", "post", "/cast", lastRequest);
  }
  function onCastResult(r) {
    const body = parse(r.text);
    log("cast result:", r.ok ? body : { status: r.status, text: r.text.trim() });
    if (!casting) return;
    if (r.ok) {
      castConfirmed = true;
      let message = body.mode === "convert" ? "casting (converting on the fly)" : "casting";
      if (body.subs === "on") message += ", with subtitles";
      if (body.subs === "unavailable") {
        message += `, without subtitles (${body.subsNote || "not supported"})`;
      }
      core.osd(`Chromecast: ${message}`);
      return;
    }
    endCasting();
    if (r.status === 424) {
      core.osd("Chromecast: ffmpeg is needed to convert this video");
      offerFfmpegInstall();
    } else if (r.status === 422) {
      core.osd("Chromecast: cannot read this media");
    } else if (r.status === 0) {
      core.osd("Chromecast: the helper is not running");
    } else {
      core.osd(`Chromecast: failed${r.text.trim() ? `: ${r.text.trim()}` : ""}`);
    }
  }
  var FFMPEG_DOWNLOAD_URL = "https://ffmpeg.org/download.html";
  function offerFfmpegInstall() {
    const open = utils2.ask(
      `This video has to be converted before the TV can play it, and that needs ffmpeg.

Either run \u201Cbrew install ffmpeg\u201D in Terminal, or download the macOS build from ffmpeg.org, unzip it and leave the \u201Cffmpeg\u201D file in your Downloads folder. Then cast again.

Open ${FFMPEG_DOWNLOAD_URL} now?`
    );
    if (open) utils2.open(FFMPEG_DOWNLOAD_URL);
  }
  function stopCasting() {
    if (!casting) return;
    log("stop casting");
    endCasting();
    ask("stop", "post", "/stop");
    core.osd("Chromecast: stopped");
  }
  function onToggled(r) {
    log("toggle result:", r.ok ? parse(r.text) : { status: r.status });
    if (!casting || !r.ok) return;
    core.osd(parse(r.text).paused === true ? "Chromecast: paused" : "Chromecast: playing");
  }
  IINAEvent.on(
    "iina.window-will-close",
    safe("window close", () => {
      log("window closing");
      stopCasting();
    })
  );
  IINAEvent.on(
    "mpv.pause.changed",
    safe("pause", () => {
      if (!casting) return;
      if (mpv.getFlag("pause")) return;
      log("play/pause pressed: toggling the device");
      core.pause();
      ask("toggle", "post", "/toggle");
    })
  );
  IINAEvent.on(
    "mpv.seek",
    safe("seek", () => {
      if (!casting) return;
      const time = mpv.getNumber("time-pos");
      log("seek to", time);
      ask("seek", "post", "/seek", { time });
    })
  );
  IINAEvent.on(
    "iina.window-loaded",
    safe("window loaded", () => {
      log("window loaded");
      rebuildMenu();
    })
  );
  setTimeout(
    safe("start", () => {
      rebuildMenu();
      setInterval(safe("tick", tick), 1e3);
    }),
    300
  );
})();
