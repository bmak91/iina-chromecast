import { discoverChromecasts } from "./discover";

const {
  utils,
  global,
  mpv,
  core,
  event: IINAEvent,
  console: IINAConsole,
  menu,
} = iina;

IINAConsole.log("Plugin is running");

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
    root.addSubMenuItem(
      menu.item(scanned ? "No Devices Found" : "Scanning...", () => {}, { enabled: false })
    );
  }
  for (const d of devices) {
    root.addSubMenuItem(menu.item(d.name, () => castCurrent(d.address)));
  }
  root.addSubMenuItem(menu.separator());
  root.addSubMenuItem(menu.item("Stop Casting", () => stopCasting(), { enabled: casting }));

  menu.removeAllItems();
  menu.addItem(root);
  menu.forceUpdate();
}

function setDevices(list: Device[]) {
  devices = list
    .filter((d) => d && typeof d.name === "string" && typeof d.address === "string")
    .sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
  scanned = true;
  rebuildMenu();
}

function refreshDevices() {
  global.postMessage("cast:devices", {});
}

global.onMessage("cast:devices:list", (r: { ok: boolean; devices?: any[] }) => {
  onMain(() => {
    const list: Device[] = (r.ok && Array.isArray(r.devices) ? r.devices : []).map((d) => ({
      name: String(d.name),
      address: `${d.ip}:${d.port}`,
    }));
    if (list.length > 0) {
      setDevices(list);
    } else {
      slowScan();
    }
  });
});

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
    .then((found) =>
      onMain(() => {
        slowScanRunning = false;
        setDevices(
          found
            .filter((d) => d.ip)
            .map((d) => ({ name: d.name, address: `${d.ip}:${d.port}` }))
        );
      })
    )
    .catch(() =>
      onMain(() => {
        slowScanRunning = false;
        if (!scanned) setDevices([]);
      })
    );
}

IINAEvent.on("iina.window-loaded", () => {
  rebuildMenu();
  refreshDevices();
  // The helper may still be starting; ask again shortly, then keep polling.
  setTimeout(refreshDevices, 800);
  setTimeout(refreshDevices, 2500);
  setInterval(refreshDevices, 5000);
  // If the helper never answers, don't sit on "Scanning..." forever.
  setTimeout(() => {
    if (!scanned) slowScan();
  }, 4000);
});

let casting = false;

function setCasting(on: boolean) {
  casting = on;
  rebuildMenu(); // enables or disables "Stop Casting"
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

function castCurrent(device: string | null) {
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
    aid: numberOrZero(() => mpv.getNumber("aid")),
  };
  sendCast();
  core.pause(); // stop decoding locally; IINA is now the remote
}

let lastRequest: Record<string, any> | null = null;

function sendCast() {
  if (!lastRequest) return;
  core.osd("Chromecast: connecting…");
  setCasting(true);
  global.postMessage("cast:load", lastRequest);
}

// Messages and promise callbacks can arrive on a background thread, where
// showing a dialog crashes IINA. Timers always fire on the main thread.
function onMain(fn: () => void) {
  setTimeout(fn, 0);
}

// The global entry reports how the cast request went.
global.onMessage("cast:result", (r: { ok: boolean; message: string; needsFfmpeg?: boolean }) => {
  onMain(() => {
    if (!casting) return;
    if (!r.ok) setCasting(false);
    core.osd(`Chromecast: ${r.message}`);
    if (r.needsFfmpeg) offerFfmpegInstall();
  });
});

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
  setCasting(false);
  global.postMessage("cast:stop", {});
}

// Don't leave the file being served once the window that cast it is gone.
IINAEvent.on("iina.window-will-close", stopCasting);

IINAEvent.on("mpv.pause.changed", () => {
  if (!casting) return;
  global.postMessage(mpv.getFlag("pause") ? "cast:pause" : "cast:play", {});
});

IINAEvent.on("mpv.seek", () => {
  if (!casting) return;
  global.postMessage("cast:seek", { time: mpv.getNumber("time-pos") });
});
