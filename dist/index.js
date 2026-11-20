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

  // src/discover.ts
  var { utils: utils2 } = iina;
  var console = { log: (...a) => makeLoggerOnce()(...a) };
  var cached = null;
  function makeLoggerOnce() {
    if (!cached) cached = makeLogger("scan").log;
    return cached;
  }
  var DNS_SD = "/usr/bin/dns-sd";
  var SERVICE = "_googlecast._tcp";
  var TIMEOUT_SEC = 3;
  var CAP = {
    VIDEO_OUT: 1 << 0,
    // 1
    VIDEO_IN: 1 << 1,
    // 2
    AUDIO_OUT: 1 << 2,
    // 4
    AUDIO_IN: 1 << 3
    // 8
  };
  function decodeCapabilities(ca) {
    if (ca === void 0) return null;
    const n = parseInt(ca, 10);
    if (Number.isNaN(n)) return null;
    return {
      videoOut: (n & CAP.VIDEO_OUT) !== 0,
      videoIn: (n & CAP.VIDEO_IN) !== 0,
      audioOut: (n & CAP.AUDIO_OUT) !== 0,
      audioIn: (n & CAP.AUDIO_IN) !== 0,
      raw: n
    };
  }
  function classify(md, caps) {
    if (md && /group/i.test(md)) return "group";
    if (caps) return caps.videoOut ? "video" : "audio";
    return "unknown";
  }
  function unescapeDNSLabel(s) {
    return s.replace(/\\(\d{3})/g, (_, d) => String.fromCharCode(parseInt(d, 10))).replace(/\\(.)/g, "$1");
  }
  function parseZone(stdout) {
    const devices2 = {};
    for (const line of stdout.split("\n")) {
      let m = line.match(/^(\S+)\s+SRV\s+\d+\s+\d+\s+(\d+)\s+(\S+)/);
      if (m) {
        const d = devices2[m[1]] || (devices2[m[1]] = {});
        d.port = parseInt(m[2], 10);
        d.hostname = m[3].replace(/\.$/, "");
        d.instanceName = unescapeDNSLabel(m[1].split(/(?<!\\)\./)[0]);
        continue;
      }
      m = line.match(/^(\S+)\s+TXT\s+(.*)$/);
      if (m) {
        const d = devices2[m[1]] || (devices2[m[1]] = {});
        const txt = d.txt || (d.txt = {});
        const pairs = m[2].match(/"([^"]*)"/g) || [];
        for (const raw of pairs) {
          const kv = raw.slice(1, -1);
          const eq = kv.indexOf("=");
          if (eq === -1) {
            txt[kv] = "";
          } else {
            txt[kv.slice(0, eq)] = kv.slice(eq + 1);
          }
        }
      }
    }
    return devices2;
  }
  function parseIP(stdout) {
    for (const line of stdout.split("\n")) {
      if (!/\bAdd\b/.test(line)) continue;
      const m = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
      if (m) return m[1];
    }
    return null;
  }
  async function resolveIP(hostname) {
    try {
      const { stdout } = await utils2.exec(DNS_SD, [
        "-t",
        String(TIMEOUT_SEC),
        "-G",
        "v4",
        hostname
      ]);
      return parseIP(stdout);
    } catch (e) {
      console.log(`dns-sd -G failed for ${hostname}: ${e}`);
      return null;
    }
  }
  async function discoverChromecasts() {
    let zone;
    try {
      const { stdout } = await utils2.exec(DNS_SD, [
        "-t",
        String(TIMEOUT_SEC),
        "-Z",
        SERVICE,
        "local"
      ]);
      zone = parseZone(stdout);
    } catch (e) {
      console.log(`dns-sd -Z failed: ${e}`);
      return [];
    }
    const entries = Object.values(zone).filter((d) => d.hostname);
    return Promise.all(
      entries.map(async (d) => {
        var _a, _b, _c, _d, _e, _f, _g;
        const txt = d.txt || {};
        const caps = decodeCapabilities(txt["ca"]);
        const st = parseInt((_a = txt["st"]) != null ? _a : "", 10);
        return {
          name: txt["fn"] || d.instanceName || d.hostname,
          hostname: d.hostname,
          ip: await resolveIP(d.hostname),
          port: (_b = d.port) != null ? _b : 8009,
          id: (_c = txt["id"]) != null ? _c : null,
          model: (_d = txt["md"]) != null ? _d : null,
          deviceType: classify(txt["md"], caps),
          isActive: !Number.isNaN(st) && st !== 0,
          statusText: (_e = txt["rs"]) != null ? _e : "",
          version: (_f = txt["ve"]) != null ? _f : null,
          iconPath: (_g = txt["ic"]) != null ? _g : null,
          capabilities: caps,
          txt
          // raw map: anything not modeled above is still here
        };
      })
    );
  }

  // src/index.ts
  var {
    utils: utils3,
    global,
    mpv,
    core,
    event: IINAEvent,
    menu
  } = iina;
  var { log, safe } = makeLogger("player");
  var devices = [];
  var scanned = false;
  var menuKey = "";
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
    root.addSubMenuItem(menu.item("Show Logs", () => utils3.open(utils3.resolvePath(LOG_DIR))));
    menu.removeAllItems();
    menu.addItem(root);
    menu.forceUpdate();
  }
  function disabledItem(title) {
    return menu.item(title, null, { enabled: false });
  }
  function setDevices(list) {
    const before = JSON.stringify(devices);
    devices = list.filter((d) => d && typeof d.name === "string" && typeof d.address === "string").sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
    if (JSON.stringify(devices) !== before || !scanned) log("devices:", devices);
    scanned = true;
    rebuildMenu();
  }
  var ticks = 0;
  function pollGlobal() {
    ticks += 1;
    global.postMessage("cast:poll", { devices: ticks <= 6 || ticks % 4 === 0 });
  }
  global.onMessage(
    "cast:devices:list",
    safe("device list", (r) => {
      if (r.ok && r.casting === false && casting && castConfirmed) {
        log("the helper reports the session has ended");
        endCasting();
        core.osd("Chromecast: casting ended");
      }
      const list = (r.ok && Array.isArray(r.devices) ? r.devices : []).map((d) => ({
        name: String(d.name),
        address: `${d.ip}:${d.port}`
      }));
      if (list.length > 0) {
        setDevices(list);
      } else if (r.ok) {
        slowScan();
      }
    })
  );
  var slowScanRunning = false;
  var lastSlowScan = 0;
  function slowScan() {
    const now = Date.now();
    if (slowScanRunning || now - lastSlowScan < 3e4) return;
    slowScanRunning = true;
    lastSlowScan = now;
    discoverChromecasts().then(
      safe("slow scan", (found) => {
        slowScanRunning = false;
        setDevices(
          found.filter((d) => d.ip).map((d) => ({ name: d.name, address: `${d.ip}:${d.port}` }))
        );
      })
    ).catch(
      safe("slow scan", () => {
        slowScanRunning = false;
        if (!scanned) setDevices([]);
      })
    );
  }
  IINAEvent.on("iina.window-loaded", () => {
    log("window loaded");
    rebuildMenu();
    startPolling();
  });
  var polling = false;
  function startPolling() {
    if (polling) return;
    polling = true;
    pollGlobal();
    setInterval(safe("poll", pollGlobal), 1e3);
    setTimeout(
      safe("scan fallback", () => {
        if (!scanned) slowScan();
      }),
      6e3
    );
  }
  var casting = false;
  var castConfirmed = false;
  var wasMuted = false;
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
  function numberOrZero(get) {
    try {
      const n = get();
      return typeof n === "number" && isFinite(n) && n > 0 ? n : 0;
    } catch (e) {
      return 0;
    }
  }
  function tryGet(get, fallback) {
    try {
      const v = get();
      return v === void 0 || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
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
    if (!device) {
      core.osd("Chromecast: device address not found");
      return;
    }
    if (!source) {
      log(`Cannot cast this source: ${JSON.stringify(url)}`);
      core.osd(url ? "Chromecast: this source cannot be cast" : "Chromecast: no file is open");
      return;
    }
    log("cast requested:", { device, source, title: core.status.title });
    lastRequest = {
      device,
      ...source,
      title: core.status.title || "IINA",
      start: numberOrZero(() => mpv.getNumber("time-pos")),
      aid: numberOrZero(() => mpv.getNumber("aid"))
    };
    const sub = selectedSubtitle();
    if (sub) lastRequest.sub = sub;
    log("cast request:", lastRequest);
    sendCast();
  }
  var lastRequest = null;
  function sendCast() {
    if (!lastRequest) return;
    core.osd("Chromecast: connecting\u2026");
    beginCasting();
    global.postMessage("cast:load", lastRequest);
  }
  global.onMessage(
    "cast:result",
    safe("cast result", (r) => {
      log("cast result:", r);
      if (!casting) return;
      if (r.ok) castConfirmed = true;
      else endCasting();
      core.osd(`Chromecast: ${r.message}`);
      if (r.needsFfmpeg) offerFfmpegInstall();
    })
  );
  var FFMPEG_DOWNLOAD_URL = "https://ffmpeg.org/download.html";
  function offerFfmpegInstall() {
    const open = utils3.ask(
      `This video has to be converted before the TV can play it, and that needs ffmpeg.

Either run \u201Cbrew install ffmpeg\u201D in Terminal, or download the macOS build from ffmpeg.org, unzip it and leave the \u201Cffmpeg\u201D file in your Downloads folder. Then cast again.

Open ${FFMPEG_DOWNLOAD_URL} now?`
    );
    if (open) utils3.open(FFMPEG_DOWNLOAD_URL);
  }
  function stopCasting() {
    if (!casting) return;
    log("stop casting");
    endCasting();
    global.postMessage("cast:stop", {});
    core.osd("Chromecast: stopped");
  }
  IINAEvent.on(
    "iina.window-will-close",
    safe("window close", () => {
      log("window closing");
      stopCasting();
    })
  );
  IINAEvent.on("mpv.pause.changed", () => {
    if (!casting) return;
    if (mpv.getFlag("pause")) return;
    log("play/pause pressed: toggling the device");
    core.pause();
    global.postMessage("cast:toggle", {});
  });
  global.onMessage(
    "cast:toggled",
    safe("toggle result", (r) => {
      log("toggle result:", r);
      if (!casting || !r.ok) return;
      core.osd(r.paused ? "Chromecast: paused" : "Chromecast: playing");
    })
  );
  IINAEvent.on(
    "mpv.seek",
    safe("seek", () => {
      if (!casting) return;
      const time = mpv.getNumber("time-pos");
      log("seek to", time);
      global.postMessage("cast:seek", { time });
    })
  );
  rebuildMenu();
  startPolling();
})();
