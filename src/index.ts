import { discoverChromecasts } from "./discover";
import { makeLogger, LOG_DIR } from "./log";

const {
  utils,
  global,
  mpv,
  core,
  event: IINAEvent,
  menu,
} = iina;

const { log, safe } = makeLogger("player");

// Everything from the plugin's global script arrives as the direct answer to
// this window's own poll (see pollGlobal), so handlers always run on the main
// thread while this instance is alive. Nothing is delivered to it later from
// another thread; that crashed IINA when the plugin was updated mid-flight.

// --- Devices and menu --------------------------------------------------------
//
// The helper keeps a live list of Cast devices (it asks the network directly,
// which takes a fraction of a second). The plugin polls that list and only
// falls back to the slow dns-sd scan when the helper has nothing to offer.

type Device = { name: string; address: string };

let devices: Device[] = [];
let scanned = false; // has any scan finished yet?
let menuKey = "";

function rebuildMenu() {
  const key = JSON.stringify([devices, casting, scanned]);
  if (key === menuKey) return;
  menuKey = key;

  const root = menu.item("Chromecast", () => {});
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
    casting
      ? menu.item("Stop Casting", safe("stop menu item", () => stopCasting()))
      : disabledItem("Stop Casting")
  );

  root.addSubMenuItem(menu.item("Show Logs", () => utils.open(utils.resolvePath(LOG_DIR))));

  menu.removeAllItems();
  menu.addItem(root);
  menu.forceUpdate();
}

// macOS enables every submenu item that has an action, whatever its "enabled"
// flag says. An item only shows as greyed out when it has no action at all.
function disabledItem(title: string) {
  return menu.item(title, null as any, { enabled: false });
}

function setDevices(list: Device[]) {
  const before = JSON.stringify(devices);
  devices = list
    .filter((d) => d && typeof d.name === "string" && typeof d.address === "string")
    .sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
  if (JSON.stringify(devices) !== before || !scanned) log("devices:", devices);
  scanned = true;
  rebuildMenu();
}

// Ask the global script for anything it has for this window. Results of cast
// requests are collected every second, the device list every few seconds
// (every second at first, so the menu fills in quickly).
let ticks = 0;
function pollGlobal() {
  ticks += 1;
  global.postMessage("cast:poll", { devices: ticks <= 6 || ticks % 4 === 0 });
}

global.onMessage(
  "cast:devices:list",
  safe("device list", (r: { ok: boolean; devices?: any[]; casting?: boolean }) => {
    // The session ended on the device (stopped with the TV remote, TV off...).
    if (r.ok && r.casting === false && casting && castConfirmed) {
      log("the helper reports the session has ended");
      endCasting();
      core.osd("Chromecast: casting ended");
    }
    const list: Device[] = (r.ok && Array.isArray(r.devices) ? r.devices : []).map((d) => ({
      name: String(d.name),
      address: `${d.ip}:${d.port}`,
    }));
    if (list.length > 0) {
      setDevices(list);
    } else if (r.ok) {
      slowScan(); // the helper is up but sees nothing: try the old scan
    }
    // Not ok: the helper is still starting. The next poll asks again.
  })
);

// Fallback: the original dns-sd based scan. It takes several seconds, so it
// runs at most every 30 seconds and never twice at once.
let slowScanRunning = false;
let lastSlowScan = 0;

function slowScan() {
  const now = Date.now();
  if (slowScanRunning || now - lastSlowScan < 30000) return;
  slowScanRunning = true;
  lastSlowScan = now;
  discoverChromecasts()
    .then(
      safe("slow scan", (found) => {
        slowScanRunning = false;
        setDevices(
          found
            .filter((d) => d.ip)
            .map((d) => ({ name: d.name, address: `${d.ip}:${d.port}` }))
        );
      })
    )
    .catch(
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

let polling = false;
function startPolling() {
  if (polling) return;
  polling = true;
  pollGlobal();
  setInterval(safe("poll", pollGlobal), 1000);
  // If the helper never answers, don't sit on "Scanning..." forever.
  setTimeout(
    safe("scan fallback", () => {
      if (!scanned) slowScan();
    }),
    6000
  );
}

let casting = false;
let castConfirmed = false; // the device accepted the media
let wasMuted = false;

function setCasting(on: boolean) {
  casting = on;
  rebuildMenu(); // enables or disables "Stop Casting"
}

function beginCasting() {
  if (!casting) {
    try {
      wasMuted = mpv.getFlag("mute");
      mpv.set("mute", true);
    } catch (e) {}
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
  } catch (e) {}
}

// What is playing: a local file (served by the helper) or a network stream
// (fetched and converted by the helper). core.status.url is already
// percent-decoded by IINA, so file URLs must not be decoded again.
function currentSource(url: string | undefined | null): { path?: string; url?: string } | null {
  if (typeof url !== "string" || url === "") return null;
  if (url.startsWith("file://localhost/")) return { path: url.slice("file://localhost".length) };
  if (url.startsWith("file:///")) return { path: url.slice("file://".length) };
  if (url.startsWith("/")) return { path: url };
  if (/^https?:\/\//i.test(url)) return { url };
  return null;
}

function numberOrZero(get: () => number): number {
  try {
    const n = get();
    return typeof n === "number" && isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}

function tryGet<T>(get: () => T, fallback: T): T {
  try {
    const v = get();
    return v === undefined || v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

// mpv prints colours as #AARRGGBB; Cast wants #RRGGBBAA.
function castColor(c: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(c || "");
  return m ? `#${m[2]}${m[1]}` : "";
}

// The subtitle track selected in IINA, with IINA's subtitle settings (delay,
// size, position, colours) as they are when casting starts.
function selectedSubtitle(): Record<string, any> | null {
  const tracks = tryGet(() => mpv.getNative<any[]>("track-list"), [] as any[]);
  if (!Array.isArray(tracks)) return null;
  const t = tracks.find((x) => x && x.type === "sub" && x.selected);
  if (!t) return null;

  const sub: Record<string, any> = {
    index: -1,
    lang: typeof t.lang === "string" ? t.lang : "",
    title: typeof t.title === "string" ? t.title : "",
    delay: tryGet(() => mpv.getNumber("sub-delay"), 0),
    // IINA's size setting is the font size (default 55); sub-scale multiplies it.
    scale:
      tryGet(() => mpv.getNumber("sub-scale"), 1) *
      (tryGet(() => mpv.getNumber("sub-font-size"), 55) / 55),
    pos: tryGet(() => mpv.getNumber("sub-pos"), 100),
    color: castColor(tryGet(() => mpv.getString("sub-color"), "")),
    borderColor: castColor(
      tryGet(() => mpv.getString("sub-border-color"), "") ||
        tryGet(() => mpv.getString("sub-outline-color"), "")
    ),
    font: tryGet(() => mpv.getString("sub-font"), ""),
    bold: tryGet(() => mpv.getFlag("sub-bold"), false),
    italic: tryGet(() => mpv.getFlag("sub-italic"), false),
  };
  if (t.external && typeof t["external-filename"] === "string") {
    const f: string = t["external-filename"];
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

function castCurrent(device: string | null) {
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
    aid: numberOrZero(() => mpv.getNumber("aid")),
  };
  const sub = selectedSubtitle();
  if (sub) lastRequest.sub = sub;
  log("cast request:", lastRequest);
  sendCast();
}

let lastRequest: Record<string, any> | null = null;

function sendCast() {
  if (!lastRequest) return;
  core.osd("Chromecast: connecting…");
  beginCasting();
  global.postMessage("cast:load", lastRequest);
}

// The global entry reports how the cast request went.
global.onMessage(
  "cast:result",
  safe("cast result", (r: { ok: boolean; message: string; needsFfmpeg?: boolean }) => {
    log("cast result:", r);
    if (!casting) return;
    if (r.ok) castConfirmed = true;
    else endCasting();
    core.osd(`Chromecast: ${r.message}`);
    if (r.needsFfmpeg) offerFfmpegInstall();
  })
);

// ffmpeg does the conversion. If it is missing, say how to get it and offer to
// open its download page. The helper also looks for a downloaded "ffmpeg" in
// the Downloads folder.
const FFMPEG_DOWNLOAD_URL = "https://ffmpeg.org/download.html";

function offerFfmpegInstall() {
  const open = utils.ask(
    "This video has to be converted before the TV can play it, and that needs ffmpeg.\n\n" +
      "Either run “brew install ffmpeg” in Terminal, or download the macOS build from " +
      "ffmpeg.org, unzip it and leave the “ffmpeg” file in your Downloads folder. " +
      "Then cast again.\n\n" +
      `Open ${FFMPEG_DOWNLOAD_URL} now?`
  );
  if (open) utils.open(FFMPEG_DOWNLOAD_URL);
}

function stopCasting() {
  if (!casting) return;
  log("stop casting");
  endCasting();
  global.postMessage("cast:stop", {});
  core.osd("Chromecast: stopped");
}

// Don't leave the file being served once the window that cast it is gone.
IINAEvent.on(
  "iina.window-will-close",
  safe("window close", () => {
    log("window closing");
    stopCasting();
  })
);

// Pressing play/pause in IINA toggles playback on the device. The local player
// is put straight back to paused, so nothing plays on the Mac.
IINAEvent.on("mpv.pause.changed", () => {
  if (!casting) return;
  if (mpv.getFlag("pause")) return; // our own pause, nothing to do
  log("play/pause pressed: toggling the device");
  core.pause();
  // The helper knows the device's real state (it may have been paused with
  // the TV remote), so it decides which way to toggle and reports back.
  global.postMessage("cast:toggle", {});
});

global.onMessage(
  "cast:toggled",
  safe("toggle result", (r: { ok: boolean; paused?: boolean }) => {
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

// After a plugin update or reload the window is already open and no
// "window-loaded" event comes, so start right away as well. (This is at the
// end of the file because it uses the state declared above.)
rebuildMenu();
startPolling();
