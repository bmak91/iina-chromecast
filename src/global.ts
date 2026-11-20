const { utils, http, global, core, console: IINAConsole } = iina;

// The helper ships inside the plugin (bin/casthelper, built from go-casthelper/
// by build-helper.sh). Nothing is downloaded at runtime. A copy you built
// yourself with install-helper.sh takes precedence.
const IDENTIFIER = "com.bmak91.iina-chromecast";
const PLUGINS = "~/Library/Application Support/com.colliderli.iina/plugins";

function findHelper(): string | null {
  const candidates = ["@data/casthelper"];
  // IINA installs a plugin as <identifier>.iinaplugin, or <identifier>-N if
  // that name is taken.
  for (const suffix of ["", "-1", "-2", "-3", "-4", "-5"]) {
    candidates.push(`${PLUGINS}/${IDENTIFIER}${suffix}.iinaplugin/bin/casthelper`);
  }
  for (const c of candidates) {
    if (utils.fileInPath(c)) return utils.resolvePath(c);
  }
  return null;
}

const bin = findHelper();
const CONTROL = "http://127.0.0.1:9092";

// The helper prints "READY <token>" on stdout once it is listening. Every
// control request must carry that token, so other local processes and web
// pages cannot drive the helper.
let token: string | null = null;
let stdoutBuf = "";

function onHelperStdout(out: string) {
  if (token) return;
  stdoutBuf = (stdoutBuf + out).slice(-4096);
  const m = stdoutBuf.match(/READY ([0-9a-f]{64})/);
  if (m) {
    token = m[1];
    stdoutBuf = "";
    IINAConsole.log("casthelper is up");
  }
}

function post(path: string, data?: Record<string, any>) {
  if (!token) {
    IINAConsole.log(`casthelper not ready, dropping ${path}`);
    return;
  }
  http
    .post(`${CONTROL}${path}`, {
      params: {},
      data: data || {},
      headers: {
        "Content-Type": "application/json",
        "X-Cast-Token": token,
      },
    })
    .catch((e) => IINAConsole.log(`casthelper ${path} failed: ${JSON.stringify(e)}`));
}

// messages arrive from each player's main entry
global.onMessage("cast:load", (d) => post("/cast", d));
global.onMessage("cast:pause", () => post("/pause"));
global.onMessage("cast:play", () => post("/play"));
global.onMessage("cast:seek", (d) => post("/seek", d));
global.onMessage("cast:stop", () => post("/stop"));

if (!bin) {
  IINAConsole.log("casthelper not found. Reinstall the plugin or run ./install-helper.sh.");
} else {
  IINAConsole.log("Starting casthelper");
  utils
    .exec(bin, ["-control", "127.0.0.1:9092", "-media", ":8010"], undefined, onHelperStdout)
    .then((r) => IINAConsole.log(`casthelper exited with status ${r.status}`))
    .catch((e) => IINAConsole.log(`casthelper failed to start: ${e}`));
}
