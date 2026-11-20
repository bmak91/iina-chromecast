(() => {
  // src/global.ts
  var { utils, http, global, core, console: IINAConsole } = iina;
  var IDENTIFIER = "com.bmak91.iina-chromecast";
  var PLUGINS = "~/Library/Application Support/com.colliderli.iina/plugins";
  function findHelper() {
    const candidates = ["@data/casthelper"];
    for (const suffix of ["", "-1", "-2", "-3", "-4", "-5"]) {
      candidates.push(`${PLUGINS}/${IDENTIFIER}${suffix}.iinaplugin/bin/casthelper`);
    }
    for (const c of candidates) {
      if (utils.fileInPath(c)) return utils.resolvePath(c);
    }
    return null;
  }
  var bin = findHelper();
  var CONTROL = "http://127.0.0.1:9092";
  var token = null;
  var stdoutBuf = "";
  function onHelperStdout(out) {
    if (token) return;
    stdoutBuf = (stdoutBuf + out).slice(-4096);
    const m = stdoutBuf.match(/READY ([0-9a-f]{64})/);
    if (m) {
      token = m[1];
      stdoutBuf = "";
      IINAConsole.log("casthelper is up");
    }
  }
  function post(path, data) {
    if (!token) {
      IINAConsole.log(`casthelper not ready, dropping ${path}`);
      return Promise.reject({ statusCode: 0, text: "helper is not running" });
    }
    return http.post(`${CONTROL}${path}`, {
      params: {},
      data: data || {},
      headers: {
        "Content-Type": "application/json",
        "X-Cast-Token": token
      }
    });
  }
  function quiet(path, data) {
    post(path, data).catch((e) => IINAConsole.log(`casthelper ${path} failed: ${JSON.stringify(e)}`));
  }
  function failureMessage(e) {
    const status = e && e.statusCode;
    if (status === 424) return "ffmpeg is needed to convert this video";
    if (status === 422) return "cannot read this media";
    if (status === 0) return "helper is not running";
    const text = e && typeof e.text === "string" ? e.text.trim() : "";
    return text ? `failed: ${text}` : "failed";
  }
  function load(d, player) {
    const reply = (r) => {
      if (player) global.postMessage(player, "cast:result", r);
    };
    post("/cast", d).then((res) => {
      const converting = /"mode":\s*"convert"/.test(res && res.text || "");
      reply({ ok: true, message: converting ? "casting (converting on the fly)" : "casting" });
    }).catch((e) => {
      IINAConsole.log(`casthelper /cast failed: ${JSON.stringify(e)}`);
      reply({ ok: false, message: failureMessage(e), needsFfmpeg: !!e && e.statusCode === 424 });
    });
  }
  global.onMessage("cast:load", (d, player) => load(d, player));
  global.onMessage("cast:pause", () => quiet("/pause"));
  global.onMessage("cast:play", () => quiet("/play"));
  global.onMessage("cast:seek", (d) => quiet("/seek", d));
  global.onMessage("cast:stop", () => quiet("/stop"));
  if (!bin) {
    IINAConsole.log("casthelper not found. Reinstall the plugin or run ./install-helper.sh.");
  } else {
    IINAConsole.log("Starting casthelper");
    utils.exec("/usr/bin/xattr", ["-d", "com.apple.quarantine", bin]).catch(() => void 0).then(() => startHelper(bin));
  }
  function startHelper(bin2) {
    utils.exec(bin2, ["-control", "127.0.0.1:9092", "-media", ":8010"], void 0, onHelperStdout).then((r) => IINAConsole.log(`casthelper exited with status ${r.status}`)).catch((e) => IINAConsole.log(`casthelper failed to start: ${e}`));
  }
})();
