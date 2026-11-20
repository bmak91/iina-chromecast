const { utils, http, global, core, console: IINAConsole } = iina;

// The helper is built locally from go-casthelper/ (see README) and copied into
// the plugin's data directory. Nothing is downloaded at runtime.
const bin = utils.resolvePath("@data/casthelper");
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

if (!utils.fileInPath(bin)) {
  IINAConsole.log(
    `casthelper not found at ${bin}. Build it with ./install-helper.sh (see README).`
  );
} else {
  IINAConsole.log("Starting casthelper");
  utils
    .exec(bin, ["-control", "127.0.0.1:9092", "-media", ":8010"], undefined, onHelperStdout)
    .then((r) => IINAConsole.log(`casthelper exited with status ${r.status}`))
    .catch((e) => IINAConsole.log(`casthelper failed to start: ${e}`));
}
