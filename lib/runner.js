/**
 * Run a Prism .pzc script headlessly-ish: `prism.exe @script.pzc`.
 *
 * Prism has no API and no exit code for script success, so completion is
 * detected with the documented done-file pattern: the script's last commands
 * write a sentinel file. If Prism never writes it (licence dialog, script
 * error dialog, wrong path) we time out and kill the Prism processes we started.
 * Unlicensed Prism switches to "viewer mode" (logged), which can't run scripts;
 * that is detected from the log so we fail fast instead of waiting for the timeout.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

// Prism 11 (system install) first: launching the portable Prism 10 hands off to
// the newest installed Prism and drops the @script argument on the way.
const PRISM_CANDIDATES = [
  "C:/Program Files/GraphPad/Prism/prism.exe",
  "C:/Users/mtsiamitas/Documents/GraphPadPrism/Prism10/prism.exe",
];

export const PRISM_EXE =
  process.env.PRISM_EXE || PRISM_CANDIDATES.find((p) => fs.existsSync(p)) || PRISM_CANDIDATES[0];

export const WORK_ROOT =
  process.env.PRISM_MCP_WORKDIR || "C:/Users/mtsiamitas/Documents/prism-mcp-work";

const LOG_DIR = path.join(process.env.APPDATA || "", "GraphPad Software/Prism");
export const PRISM_LOGS = [
  path.join(LOG_DIR, "11.0/Prism 11 log.txt"),
  path.join(LOG_DIR, "10.0/Prism 10 log.txt"),
];

const SENTINEL = "__prism_mcp_done.txt";

const sizeOf = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
const logSizes = () => PRISM_LOGS.map(sizeOf);

/** Log lines Prism wrote since the given byte offsets, minus the noise. */
function prismLogSince(offsets) {
  return PRISM_LOGS.flatMap((file, i) => {
    if (!fs.existsSync(file)) return [];
    const buf = fs.readFileSync(file);
    return buf
      .subarray(Math.min(offsets[i], buf.length))
      .toString("utf8")
      .split(/\r?\n/)
      .filter((l) => l && !/GC:|PZDestroyMenu|EBWebView/.test(l));
  });
}

/**
 * Once Prism has fallen back to viewer mode it starts straight in it on later
 * launches and logs nothing; only the window title ("(Viewer mode)") shows it.
 */
function prismWindowTitles() {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-Process prism -ErrorAction SilentlyContinue | ForEach-Object MainWindowTitle"],
      { encoding: "utf8" }
    );
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Kill Prism processes started after `sinceMs`. Prism restarts itself (e.g. into
 * viewer mode) as a new process, so killing our child is not enough.
 */
function killPrismStartedAfter(sinceMs) {
  const ps =
    `Get-Process prism -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.StartTime -ge [DateTime]::FromFileTimeUtc(${(sinceMs + 11644473600000) * 10000}).ToLocalTime() } | ` +
    `ForEach-Object { $_.Id; Stop-Process -Id $_.Id -Force }`;
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
const POLL_MS = 500;
const TITLE_CHECK_EVERY = 6; // window-title check spawns PowerShell: every 3 s

/** Prism script paths are Windows paths inside double quotes. */
export const winPath = (p) => path.resolve(p).replace(/\//g, "\\");

export function newRunDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(WORK_ROOT, `run-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Wrap user script: SetPath to the run dir first, sentinel + optional Exit last. */
export function wrapScript(body, runDir, exitWhenDone) {
  return [
    `SetPath "${winPath(runDir)}"`,
    body.trim(),
    `OpenOutput "${SENTINEL}", CLEAR`,
    `WText "done"`,
    `CloseOutput`,
    exitWhenDone ? "Exit" : "",
    "",
  ].join("\r\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runPrismScript({ script, runDir, timeoutSec = 120, exitWhenDone = true }) {
  if (!fs.existsSync(PRISM_EXE)) {
    throw new Error(`prism.exe not found at ${PRISM_EXE} (set PRISM_EXE)`);
  }
  const scriptPath = path.join(runDir, "script.pzc");
  const sentinelPath = path.join(runDir, SENTINEL);
  if (fs.existsSync(sentinelPath)) fs.unlinkSync(sentinelPath);
  // Prism is single-instance: with a window already open, the @script runs in
  // THAT window, so Exit/kill would close the user's Prism. Never do that.
  const userPrismOpen = prismWindowTitles().length > 0;
  if (userPrismOpen) exitWhenDone = false;
  fs.writeFileSync(scriptPath, wrapScript(script, runDir, exitWhenDone), "utf8");

  const logStart = logSizes();
  const started = Date.now();

  const child = spawn(PRISM_EXE, [`@${winPath(scriptPath)}`], {
    windowsHide: false,
    detached: false,
    stdio: "ignore",
  });
  let spawnError = null;
  child.on("error", (e) => {
    spawnError = e;
  });

  // Don't stop when our child exits: Prism may restart itself as a new process.
  const isViewer = (lines) => lines.some((l) => /Application mode: viewer|viewer mode/i.test(l));
  let done = false;
  let viewerMode = false;
  for (let tick = 0; !spawnError && Date.now() - started < timeoutSec * 1000; tick++) {
    if (fs.existsSync(sentinelPath)) {
      done = true;
      break;
    }
    const titleCheck = tick % TITLE_CHECK_EVERY === 0;
    if (isViewer(prismLogSince(logStart)) || (titleCheck && isViewer(prismWindowTitles()))) {
      viewerMode = true;
      break;
    }
    await sleep(POLL_MS);
  }

  // Let Prism finish its own Exit after the sentinel, then clean up leftovers
  if (done && exitWhenDone) await sleep(3000);
  const killedPids =
    !userPrismOpen && (!done || exitWhenDone) ? killPrismStartedAfter(started - 2000) : [];

  const log = done ? [] : prismLogSince(logStart);

  return {
    completed: done,
    prism_exe: PRISM_EXE,
    ran_in_users_open_prism: userPrismOpen,
    unlicensed_viewer_mode: viewerMode,
    prism_log_tail: log.slice(-15),
    timed_out: !done && !viewerMode && !spawnError,
    killed_leftover_prism_pids: killedPids,
    spawn_error: spawnError ? String(spawnError.message) : null,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    run_dir: runDir,
    script_path: scriptPath,
    hint: done
      ? null
      : viewerMode
      ? "Prism is not licensed: it switched to viewer mode, which cannot run scripts. " +
        "Activate Prism (Help > Activate, email sign-in or serial) and retry."
      : "Prism did not reach the end of the script. Usual causes: licence/activation dialog, " +
        "a script error dialog, a startup dialog (Welcome), or a wrong file path. Run with " +
        "exit_when_done=false and look at the Prism window.",
  };
}

/** Collect small text outputs the script wrote into the run dir. */
export function collectOutputs(runDir, maxBytes = 200_000) {
  return fs
    .readdirSync(runDir)
    .filter((f) => f !== "script.pzc" && f !== SENTINEL)
    .map((f) => {
      const full = path.join(runDir, f);
      const size = fs.statSync(full).size;
      const isText = /\.(txt|csv|tsv|xml)$/i.test(f);
      return {
        file: full,
        size,
        content: isText && size <= maxBytes ? fs.readFileSync(full, "utf8") : null,
      };
    });
}
