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
    const devices = {};
    for (const line of stdout.split("\n")) {
      let m = line.match(/^(\S+)\s+SRV\s+\d+\s+\d+\s+(\d+)\s+(\S+)/);
      if (m) {
        const d = devices[m[1]] || (devices[m[1]] = {});
        d.port = parseInt(m[2], 10);
        d.hostname = m[3].replace(/\.$/, "");
        d.instanceName = unescapeDNSLabel(m[1].split(/(?<!\\)\./)[0]);
        continue;
      }
      m = line.match(/^(\S+)\s+TXT\s+(.*)$/);
      if (m) {
        const d = devices[m[1]] || (devices[m[1]] = {});
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
    return devices;
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
    standaloneWindow,
    overlay,
    sidebar,
    global,
    mpv,
    core,
    event: IINAEvent,
    console: IINAConsole,
    menu
  } = iina;
  IINAConsole.log("Plugin is running");
  var noDevicesFoundMenuItem = null;
  var scanningMenuItem = null;
  function noDevicesFoundMenu() {
    if (noDevicesFoundMenuItem) return noDevicesFoundMenuItem;
    noDevicesFoundMenuItem = menu.item("Chromecast", () => {
    });
    noDevicesFoundMenuItem.addSubMenuItem(
      menu.item("No Devices Found", () => {
      }, {
        enabled: false
      })
    );
    return noDevicesFoundMenuItem;
  }
  function scanningMenu() {
    if (scanningMenuItem) return scanningMenuItem;
    scanningMenuItem = menu.item("Chromecast", () => {
    });
    scanningMenuItem.addSubMenuItem(
      menu.item("Scanning...", () => {
      }, {
        enabled: false
      })
    );
    return scanningMenuItem;
  }
  function devicesMenu(devices) {
    let devicesMenuItem = menu.item("Chromecast", () => {
    });
    for (let i = 0; i < devices.length; i++) {
      devicesMenuItem.addSubMenuItem(
        menu.item(devices[i].name, () => {
          castCurrent(devices[i].ip);
        })
      );
    }
    devicesMenuItem.addSubMenuItem(menu.separator());
    devicesMenuItem.addSubMenuItem(menu.item("Stop Casting", () => stopCasting()));
    return devicesMenuItem;
  }
  IINAEvent.on("iina.window-loaded", () => {
    menu.removeAllItems();
    menu.addItem(scanningMenu());
    dynamicMenu();
    setInterval(dynamicMenu, 3e4);
  });
  async function dynamicMenu() {
    IINAConsole.log("Running dynamic menu");
    const devices = await discoverChromecasts();
    if (devices.length > 0) {
      menu.removeAllItems();
      menu.addItem(devicesMenu(devices));
    } else {
      menu.removeAllItems();
      menu.addItem(noDevicesFoundMenu());
    }
  }
  var casting = false;
  function localPath(url) {
    if (typeof url !== "string" || url === "") return null;
    if (url.startsWith("file://localhost/")) return url.slice("file://localhost".length);
    if (url.startsWith("file:///")) return url.slice("file://".length);
    return url.startsWith("/") ? url : null;
  }
  function castCurrent(device) {
    const url = core.status.url;
    const path = localPath(url);
    if (!device) {
      core.osd("Chromecast: device address not found");
      return;
    }
    if (!path) {
      IINAConsole.log(`Cannot cast, not a local file: ${JSON.stringify(url)}`);
      core.osd(url ? "Chromecast: only local files can be cast" : "Chromecast: no file is open");
      return;
    }
    IINAConsole.log("Casting current media to ", device);
    global.postMessage("cast:load", {
      device,
      path,
      contentType: "video/mp4",
      title: core.status.title || "IINA"
    });
    casting = true;
    core.pause();
  }
  function stopCasting() {
    if (!casting) return;
    casting = false;
    global.postMessage("cast:stop", {});
  }
  IINAEvent.on("iina.window-will-close", stopCasting);
  IINAEvent.on("mpv.pause.changed", () => {
    if (!casting) return;
    global.postMessage(mpv.getFlag("pause") ? "cast:pause" : "cast:play", {});
  });
  IINAEvent.on("mpv.seek", () => {
    if (!casting) return;
    global.postMessage("cast:seek", { time: mpv.getNumber("time-pos") });
  });
})();
