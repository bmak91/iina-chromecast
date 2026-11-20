(() => {
  // src/discover.ts
  var { utils, console } = iina;
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
      const { stdout } = await utils.exec(DNS_SD, [
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
      const { stdout } = await utils.exec(DNS_SD, [
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
    utils: utils2,
    global,
    mpv,
    core,
    event: IINAEvent,
    console: IINAConsole,
    menu
  } = iina;
  IINAConsole.log("Plugin is running");
  var onMain = (fn) => {
    setTimeout(fn, 0);
  };
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
      root.addSubMenuItem(menu.item(d.name, () => castCurrent(d.address)));
    }
    root.addSubMenuItem(menu.separator());
    root.addSubMenuItem(
      casting ? menu.item("Stop Casting", () => stopCasting()) : disabledItem("Stop Casting")
    );
    root.addSubMenuItem(menu.item("Show Helper Log", () => utils2.open("@data/casthelper.log")));
    menu.removeAllItems();
    menu.addItem(root);
    menu.forceUpdate();
  }
  function disabledItem(title) {
    return menu.item(title, null, { enabled: false });
  }
  function setDevices(list) {
    devices = list.filter((d) => d && typeof d.name === "string" && typeof d.address === "string").sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
    scanned = true;
    rebuildMenu();
  }
  function refreshDevices() {
    global.postMessage("cast:devices", {});
  }
  global.onMessage("cast:devices:list", (r) => {
    onMain(() => {
      if (r.ok && r.casting === false && casting && castConfirmed) {
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
    });
  });
  var slowScanRunning = false;
  var lastSlowScan = 0;
  function slowScan() {
    const now = Date.now();
    if (slowScanRunning || now - lastSlowScan < 3e4) return;
    slowScanRunning = true;
    lastSlowScan = now;
    discoverChromecasts().then(
      (found) => onMain(() => {
        slowScanRunning = false;
        setDevices(
          found.filter((d) => d.ip).map((d) => ({ name: d.name, address: `${d.ip}:${d.port}` }))
        );
      })
    ).catch(
      () => onMain(() => {
        slowScanRunning = false;
        if (!scanned) setDevices([]);
      })
    );
  }
  IINAEvent.on("iina.window-loaded", () => {
    rebuildMenu();
    refreshDevices();
    setTimeout(refreshDevices, 800);
    setTimeout(refreshDevices, 2500);
    setInterval(refreshDevices, 5e3);
    setTimeout(() => {
      if (!scanned) slowScan();
    }, 4e3);
  });
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
      IINAConsole.log(`Cannot cast this source: ${JSON.stringify(url)}`);
      core.osd(url ? "Chromecast: this source cannot be cast" : "Chromecast: no file is open");
      return;
    }
    IINAConsole.log("Casting current media to ", device);
    lastRequest = {
      device,
      ...source,
      title: core.status.title || "IINA",
      start: numberOrZero(() => mpv.getNumber("time-pos")),
      aid: numberOrZero(() => mpv.getNumber("aid"))
    };
    const sub = selectedSubtitle();
    if (sub) lastRequest.sub = sub;
    sendCast();
  }
  var lastRequest = null;
  function sendCast() {
    if (!lastRequest) return;
    core.osd("Chromecast: connecting\u2026");
    beginCasting();
    global.postMessage("cast:load", lastRequest);
  }
  global.onMessage("cast:result", (r) => {
    onMain(() => {
      if (!casting) return;
      if (r.ok) castConfirmed = true;
      else endCasting();
      core.osd(`Chromecast: ${r.message}`);
      if (r.needsFfmpeg) offerFfmpegInstall();
    });
  });
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
    endCasting();
    global.postMessage("cast:stop", {});
    core.osd("Chromecast: stopped");
  }
  IINAEvent.on("iina.window-will-close", stopCasting);
  IINAEvent.on("mpv.pause.changed", () => {
    if (!casting) return;
    if (mpv.getFlag("pause")) return;
    core.pause();
    global.postMessage("cast:toggle", {});
  });
  global.onMessage("cast:toggled", (r) => {
    onMain(() => {
      if (!casting || !r.ok) return;
      core.osd(r.paused ? "Chromecast: paused" : "Chromecast: playing");
    });
  });
  IINAEvent.on("mpv.seek", () => {
    if (!casting) return;
    global.postMessage("cast:seek", { time: mpv.getNumber("time-pos") });
  });
})();
