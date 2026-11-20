// Always-on log for the plugin's own scripts.
//
// Lines are appended to ~/Library/Logs/IINA Chromecast/plugin.log (the helper
// writes helper.log next to it). The file is created readable only by the
// user's account processes that created it and is rolled over at 1 MB, so
// there is always a trail to read after something goes wrong, without
// growing forever.

import info from "../Info.json";

const { utils, file, console: IINAConsole } = iina;

export const LOG_DIR = "~/Library/Logs/IINA Chromecast";
const LOG_FILE = `${LOG_DIR}/plugin.log`;
const PREV_FILE = `${LOG_DIR}/plugin.prev.log`;
const MAX_BYTES = 1 << 20;
const MAX_PENDING = 500;

let dirRequested = false;
let pending: string[] = [];

function ensureDir() {
  if (dirRequested) return;
  dirRequested = true;
  try {
    utils.exec("/bin/mkdir", ["-p", "-m", "700", utils.resolvePath(LOG_DIR)]).catch(() => undefined);
  } catch (e) {}
}

function flush() {
  if (pending.length === 0) return;
  try {
    if (!file.exists(LOG_FILE)) {
      // Creating a new file is allowed anywhere; appending needs a handle.
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
      utils
        .exec("/bin/mv", ["-f", utils.resolvePath(LOG_FILE), utils.resolvePath(PREV_FILE)])
        .catch(() => undefined);
    }
  } catch (e) {
    // The folder may not exist yet; keep the lines and try again later.
    if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
  }
}

function text(v: any): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.message}\n${v.stack || ""}`;
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

export function makeLogger(tag: string) {
  ensureDir();
  const log = (...args: any[]) => {
    const msg = args.map(text).join(" ");
    try {
      IINAConsole.log(msg);
    } catch (e) {}
    pending.push(`${new Date().toISOString()} [${tag}] ${msg}\n`);
    flush();
  };
  // Wraps a callback so that an exception is written to the log instead of
  // disappearing into IINA's console.
  const safe = <A extends any[]>(what: string, fn: (...args: A) => void) => {
    return (...args: A) => {
      try {
        fn(...args);
      } catch (e) {
        log(`ERROR in ${what}:`, e);
      }
    };
  };
  log(`--- started, plugin ${info.version} ---`);
  setTimeout(flush, 1500); // in case the folder did not exist on the first try
  return { log, safe };
}
