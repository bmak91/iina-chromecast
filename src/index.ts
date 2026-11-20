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

// Only local files can be cast: the helper serves the file itself.
// core.status.url is already percent-decoded by IINA, so it must not be decoded
// again (a "%" in the file name would break).
function localPath(url: string | undefined | null): string | null {
  if (typeof url !== "string" || url === "") return null;
  if (url.startsWith("file://localhost/")) return url.slice("file://localhost".length);
  if (url.startsWith("file:///")) return url.slice("file://".length);
  return url.startsWith("/") ? url : null;
}

function castCurrent(device: string | null) {
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
    title: core.status.title || "IINA",
  });
  casting = true;
  core.pause(); // stop decoding locally; IINA is now the remote
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
