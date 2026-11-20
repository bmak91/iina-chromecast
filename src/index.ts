import { makeLogger, LOG_DIR } from "./log";

const { utils, http, file, mpv, core, event: IINAEvent, menu } = iina;
const { log, safe } = makeLogger("player");

// --- How this script stays safe -----------------------------------------------
//
// IINA runs network callbacks on background threads, and it can replace this
// script's plugin instance (on update or reload) at any moment. Calling an
// iina.* API from a background thread, from a callback that outlives the
// instance, or across instances (player <-> global messages) crashes IINA.
//
// So this script talks to the helper directly over HTTP and follows two rules:
//
//   1. A network callback only pushes a plain object onto `inbox`.
//   2. Everything else happens in the one-second timer (`tick`), in menu
//      actions and in IINA events: on the main thread, in an instance that is
//      alive (IINA removes an instance's timers and listeners when it goes).
//
// There are no messages between this script and the global script at all.

const CONTROL = "http://127.0.0.1:9092";
const TOKEN_FILE = "@data/casthelper.token";

type Reply = { kind: string; ok: boolean; status: number; text: string };
const inbox: Reply[] = [];

function readToken(): string {
  try {
    const t = file.read(TOKEN_FILE, {});
    return typeof t === "string" && /^[0-9a-f]{64}$/.test(t.trim()) ? t.trim() : "";
  } catch (e) {
    return "";
  }
}

// Sends a request to the helper. The answer shows up in `inbox` and is handled
// by the next tick.
function ask(kind: string, method: "get" | "post", path: string, data?: Record<string, any>) {
  const token = readToken();
  if (!token) {
    inbox.push({ kind, ok: false, status: 0, text: "" });
    return;
  }
  const options = {
    params: {},
    data: data || {},
    headers: { "Content-Type": "application/json", "X-Cast-Token": token },
  };
  const p = method === "get" ? http.get(`${CONTROL}${path}`, options) : http.post(`${CONTROL}${path}`, options);
  p.then((res: any) => {
    inbox.push({ kind, ok: true, status: 200, text: (res && res.text) || "" });
  }).catch((e: any) => {
    inbox.push({
      kind,
      ok: false,
      status: (e && typeof e.statusCode === "number" && e.statusCode) || -1,
      text: (e && typeof e.text === "string" && e.text) || "",
    });
  });
}

function parse(text: string): Record<string, any> {
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" ? v : {};
  } catch (e) {
    return {};
  }
}

// --- Devices and menu --------------------------------------------------------

type Device = { name: string; address: string };

let devices: Device[] = [];
let scanned = false; // has the helper answered with a device list yet?
let menuKey = "";

// While casting, IINA is only the remote control: the local player stays
// paused and muted, and play/pause and seeking are sent to the device.
let casting = false;
let castConfirmed = false; // the device accepted the media
let wasMuted = false;
let lastRequest: Record<string, any> | null = null;

// macOS enables every submenu item that has an action, whatever its "enabled"
// flag says. An item only shows as greyed out when it has no action at all.
function disabledItem(title: string) {
  return menu.item(title, null as any, { enabled: false });
}

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

function setDevices(list: Device[]) {
  const before = JSON.stringify(devices);
  devices = list
    .filter((d) => d && typeof d.name === "string" && typeof d.address === "string")
    .sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
  if (JSON.stringify(devices) !== before || !scanned) log("devices:", devices);
  scanned = true;
  rebuildMenu();
}

// --- The tick ------------------------------------------------------------------

let ticks = 0;
let emptyAnswers = 0;
let lastProblem = "";

function tick() {
  ticks += 1;

  // 1. Handle whatever came back from the helper since the last tick.
  while (inbox.length > 0) {
    const r = inbox.shift() as Reply;
    if (r.kind === "devices") onDevices(r);
    else if (r.kind === "cast") onCastResult(r);
    else if (r.kind === "toggle") onToggled(r);
    else if (!r.ok) log(`${r.kind} failed:`, r.status, r.text.trim());
  }

  // 2. Ask for the device list: every second until a device shows up, so the
  //    menu fills in quickly, then every four seconds.
  if (devices.length === 0 || ticks % 4 === 0) ask("devices", "get", "/devices");
}

function onDevices(r: Reply) {
  if (!r.ok) {
    // The helper is not up (yet). After a while, say so in the menu.
    emptyAnswers += 1;
    if (emptyAnswers === 8) {
      log("the helper is not answering:", r.status, r.text.trim());
      setDevices([]);
    }
    return;
  }
  emptyAnswers = 0;
  const body = parse(r.text);
  const list: Device[] = (Array.isArray(body.devices) ? body.devices : []).map((d: any) => ({
    name: String(d.name),
    address: `${d.ip}:${d.port}`,
  }));
  // The first answers can come before any device has replied, and macOS can
  // refuse the helper's network query for a while after it starts. Keep
  // showing "Scanning..." through that instead of "No Devices Found".
  const problem = typeof body.problem === "string" ? body.problem : "";
  if (problem !== lastProblem) {
    lastProblem = problem;
    log(problem ? `discovery problem: ${problem}` : "discovery is working");
  }
  if (list.length > 0 || ticks > (problem ? 45 : 8)) setDevices(list);

  // The session ended on the device (stopped with the TV remote, TV off...).
  if (body.casting === false && casting && castConfirmed) {
    log("the helper reports the session has ended");
    endCasting();
    core.osd("Chromecast: casting ended");
  }
}

// --- Casting -----------------------------------------------------------------

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

function tryGet<T>(get: () => T, fallback: T): T {
  try {
    const v = get();
    return v === undefined || v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function positive(n: number): number {
  return typeof n === "number" && isFinite(n) && n > 0 ? n : 0;
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

function castCurrent(device: string) {
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
    aid: positive(tryGet(() => mpv.getNumber("aid"), 0)),
  };
  const sub = selectedSubtitle();
  if (sub) lastRequest.sub = sub;
  log("cast request:", lastRequest);
  core.osd("Chromecast: connecting…");
  beginCasting();
  ask("cast", "post", "/cast", lastRequest);
}

function onCastResult(r: Reply) {
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
  ask("stop", "post", "/stop");
  core.osd("Chromecast: stopped");
}

function onToggled(r: Reply) {
  log("toggle result:", r.ok ? parse(r.text) : { status: r.status });
  if (!casting || !r.ok) return;
  core.osd(parse(r.text).paused === true ? "Chromecast: paused" : "Chromecast: playing");
}

// --- IINA events ---------------------------------------------------------------

// Don't leave the file being served once the window that cast it is gone.
IINAEvent.on(
  "iina.window-will-close",
  safe("window close", () => {
    log("window closing");
    stopCasting();
  })
);

// Pressing play/pause in IINA toggles playback on the device. The local player
// is put straight back to paused, so nothing plays on the Mac. The helper knows
// the device's real state (it may have been paused with the TV remote), so it
// decides which way to toggle.
IINAEvent.on(
  "mpv.pause.changed",
  safe("pause", () => {
    if (!casting) return;
    if (mpv.getFlag("pause")) return; // our own pause, nothing to do
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

// Start a moment after loading rather than during it: while IINA is still
// constructing this instance, very little is safe to call.
setTimeout(
  safe("start", () => {
    rebuildMenu();
    setInterval(safe("tick", tick), 1000);
  }),
  300
);
