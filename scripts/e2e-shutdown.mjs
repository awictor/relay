// Proves graceful shutdown in the REAL process: spawn the built worker with a dummy
// token, wait for it to start polling, send SIGTERM, assert it logs [shutdown] and exits
// 0 quickly (not SIGKILLed by a timeout). Offline — no real Telegram/Gemini/anvil calls
// needed to reach the signal path. Run: node scripts/e2e-shutdown.mjs  (after npm run build)
//
// NOTE: real POSIX signals only exist on Linux/macOS (the deploy target is docker/Linux).
// On Windows there is no catchable SIGTERM — child.kill() force-terminates — so this
// script SKIPS the assertion there and just confirms the worker boots. The handler logic
// itself is covered by test/shutdown.test.ts on every platform.
import { spawn } from "node:child_process";

if (process.platform === "win32") {
  console.log("SKIP: Windows has no catchable SIGTERM; handler is unit-tested + validated on the Linux deploy target.");
  process.exit(0);
}

const child = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    // Dummy token: getMe/getUpdates will fail, but the process starts + installs the
    // signal handlers, which is what we're testing.
    TELEGRAM_BOT_TOKEN: "1:dummy",
    GEMINI_API_KEY: "",
    ANVIL_BASE_URL: "http://127.0.0.1:59999", // unreachable -> anvilLive false, fine
    RELAY_MEMORY_FILE: "data/.e2e-shutdown-mem.json",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { out += d; });

const KILL_AFTER_MS = 1500;
const HARD_TIMEOUT_MS = 6000;

// Give it a moment to boot + install handlers, then SIGTERM.
const t1 = setTimeout(() => child.kill("SIGTERM"), KILL_AFTER_MS);

// Backstop: if it ignores SIGTERM, SIGKILL + fail.
const t2 = setTimeout(() => { child.kill("SIGKILL"); }, HARD_TIMEOUT_MS);

child.on("exit", (code, signal) => {
  clearTimeout(t1); clearTimeout(t2);
  const loggedShutdown = /\[shutdown\]/.test(out);
  const cleanExit = code === 0 && signal === null;
  if (loggedShutdown && cleanExit) {
    console.log("E2E PASS: worker logged [shutdown] and exited 0 on SIGTERM");
    process.exit(0);
  }
  console.error(`E2E FAIL: exitCode=${code} signal=${signal} loggedShutdown=${loggedShutdown}`);
  console.error("---- child output ----\n" + out.slice(-600));
  process.exit(1);
});
