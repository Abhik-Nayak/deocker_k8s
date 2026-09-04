// Runs the auth-server's Python inside its virtualenv, whatever the platform.
//
//   node scripts/venv-python.mjs -m uvicorn app.main:app --reload --port 4000
//
// npm scripts cannot hardcode ".venv/Scripts/python.exe" (Windows) or
// ".venv/bin/python" (macOS / Linux) at the same time, so the path is resolved
// here and the arguments are forwarded as-is. Falls back to the Python on PATH
// when no virtualenv has been created yet.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const authServer = join(dirname(fileURLToPath(import.meta.url)), "..", "auth-server");

const candidates =
  process.platform === "win32"
    ? [join(authServer, ".venv", "Scripts", "python.exe")]
    : [join(authServer, ".venv", "bin", "python3"), join(authServer, ".venv", "bin", "python")];

const python = candidates.find(existsSync);

if (!python) {
  console.warn(
    "[auth] no virtualenv at auth-server/.venv - falling back to the Python on PATH.\n" +
      "[auth] run `npm run setup` first to create it."
  );
}

const child = spawn(python ?? (process.platform === "win32" ? "python" : "python3"), process.argv.slice(2), {
  cwd: authServer,
  stdio: "inherit",
});

child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
child.on("error", (err) => {
  console.error(`[auth] failed to start Python: ${err.message}`);
  process.exit(1);
});
