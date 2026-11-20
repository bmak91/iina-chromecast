import { discoverChromecasts, DiscoverResult } from "./discover";

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

let noDevicesFoundMenuItem: IINA.MenuItem = null;
let scanningMenuItem: IINA.MenuItem = null;

function noDevicesFoundMenu() {
  if (noDevicesFoundMenuItem) return noDevicesFoundMenuItem;
  noDevicesFoundMenuItem = menu.item("Chromecast", () => {});
  noDevicesFoundMenuItem.addSubMenuItem(
    menu.item("No Devices Found", () => {}, {
      enabled: false,
    })
  );
  return noDevicesFoundMenuItem;
}

function scanningMenu() {
  if (scanningMenuItem) return scanningMenuItem;
  scanningMenuItem = menu.item("Chromecast", () => {});
  scanningMenuItem.addSubMenuItem(
    menu.item("Scanning...", () => {}, {
      enabled: false,
    })
  );
  return scanningMenuItem;
}

function devicesMenu(devices: DiscoverResult[]) {
  let devicesMenuItem = menu.item("Chromecast", () => {});
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
  setInterval(dynamicMenu, 30000);
});

// Start scanning and updating menu items
async function dynamicMenu() {
  IINAConsole.log("Running dynamic menu");

  // Start searching for devices and do it every 30 seconds
  const devices = await discoverChromecasts();
  if (devices.length > 0) {
    menu.removeAllItems();
    menu.addItem(devicesMenu(devices));
  } else {
    menu.removeAllItems();
    menu.addItem(noDevicesFoundMenu());
  }
}

let casting = false;

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
  casting = true;
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
    if (!r.ok) casting = false;
    core.osd(`Chromecast: ${r.message}`);
    if (r.needsFfmpeg) offerFfmpegInstall();
  });
});

// ffmpeg does the conversion. If it is missing, offer to install it with
// Homebrew (after asking), then retry the cast.
const BREW_PATHS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
let installingFfmpeg = false;

function offerFfmpegInstall() {
  if (installingFfmpeg) {
    core.osd("Chromecast: ffmpeg is still installing…");
    return;
  }
  const brew = BREW_PATHS.find((p) => utils.fileInPath(p));
  if (!brew) {
    utils.ask(
      "This video has to be converted before the TV can play it, and that needs ffmpeg.\n\n" +
        "Install Homebrew from https://brew.sh, run “brew install ffmpeg” in Terminal, then cast again."
    );
    return;
  }
  const ok = utils.ask(
    "This video has to be converted before the TV can play it, and that needs ffmpeg.\n\n" +
      "Install ffmpeg now with Homebrew? It takes a few minutes; casting starts when it is done."
  );
  if (!ok) return;

  installingFfmpeg = true;
  core.osd("Chromecast: installing ffmpeg, this takes a few minutes…");
  // IINA starts programs with an empty environment; Homebrew needs HOME and PATH.
  const home = utils.resolvePath("~/").replace(/\/$/, "");
  utils
    .exec("/usr/bin/env", [
      `HOME=${home}`,
      "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      "NONINTERACTIVE=1",
      brew,
      "install",
      "ffmpeg",
    ])
    .then((res) =>
      onMain(() => {
        installingFfmpeg = false;
        if (res.status !== 0) {
          IINAConsole.log(`brew install ffmpeg failed (${res.status}): ${res.stderr.slice(-2000)}`);
          core.osd("Chromecast: could not install ffmpeg, see the plugin log");
          return;
        }
        core.osd("Chromecast: ffmpeg installed");
        sendCast();
      })
    )
    .catch((e) =>
      onMain(() => {
        installingFfmpeg = false;
        IINAConsole.log(`brew install ffmpeg could not start: ${JSON.stringify(e)}`);
        core.osd("Chromecast: could not install ffmpeg, see the plugin log");
      })
    );
}

function stopCasting() {
  if (!casting) return;
  casting = false;
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
