import { discoverChromecasts, DiscoverResult } from "./discover";

const {
  standaloneWindow,
  overlay,
  sidebar,
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
  core.osd("Chromecast: connecting…");
  global.postMessage("cast:load", {
    device,
    ...source,
    title: core.status.title || "IINA",
    start: numberOrZero(() => mpv.getNumber("time-pos")),
    aid: numberOrZero(() => mpv.getNumber("aid")),
  });
  casting = true;
  core.pause(); // stop decoding locally; IINA is now the remote
}

// The global entry reports how the cast request went.
global.onMessage("cast:result", (r: { ok: boolean; message: string }) => {
  if (!casting) return;
  if (!r.ok) casting = false;
  core.osd(`Chromecast: ${r.message}`);
});

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
