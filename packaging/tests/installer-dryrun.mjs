#!/usr/bin/env node
// Installer DryRun contract test (1.7.0).
//
// Runs the shipped (or authoring) installer with -DryRun -Json and asserts that:
//   * the process exits 0 and stdout is pure JSON (human chatter goes to stderr),
//   * the DryRun object reports the version the package manifest carries,
//   * nothing is written: the requested install root stays absent, and the stack
//     config plus the project client config keep their previous timestamps.
//
// The test skips while UE4Editor is open (and says why): a dry run proved mid-session
// says nothing about the install a user will actually run. Close the editor for a real pass.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const options = {
  install: "",
  project: "D:/Uprojects/mcptest2/mcptest2.uproject",
  engine: "D:/UE-ViteFork",
  manifest: "",
  installRoot: "",
};
for (let i = 0; i < args.length; i += 1) {
  const key = args[i];
  const value = args[i + 1];
  if (key === "--install") { options.install = value; i += 1; }
  else if (key === "--project") { options.project = value; i += 1; }
  else if (key === "--engine") { options.engine = value; i += 1; }
  else if (key === "--manifest") { options.manifest = value; i += 1; }
  else if (key === "--install-root") { options.installRoot = value; i += 1; }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const candidates = [
  options.install,
  path.join(cwd, "install.ps1"),
  path.join(here, "..", "install.ps1"),
  path.join(here, "..", "..", "installer", "Install-UEV.ps1"),
].filter(Boolean);
const installScript = candidates.find((candidate) => fs.existsSync(candidate));
if (!installScript) {
  console.error("FAIL: no installer script found; pass --install <path-to-install.ps1>");
  process.exitCode = 1;
  process.exit();
}

const manifestCandidates = [
  options.manifest,
  path.join(path.dirname(installScript), "manifest.json"),
].filter(Boolean);
const manifestPath = manifestCandidates.find((candidate) => fs.existsSync(candidate));
const manifest = manifestPath ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;

const installRoot = options.installRoot || path.join(os.tmpdir(), "uev-dryrun-" + Date.now().toString(36));
const stackConfig = path.join(process.env.LOCALAPPDATA || "", "UEV", "stack.json");
const clientConfig = path.join(path.dirname(options.project), "Saved", "UEV", "mcp-client.json");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " - " + detail : ""));
}

function stamp(p) {
  try {
    const st = fs.statSync(p);
    return st.mtimeMs + ":" + st.size;
  } catch {
    return "absent";
  }
}

function editorRunning() {
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "(Get-Process -Name UE4Editor -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: "utf8" });
  const count = Number.parseInt((out.stdout || "0").trim(), 10);
  return Number.isFinite(count) && count > 0;
}

if (editorRunning()) {
  console.log("SKIP installer-dryrun: UE4Editor is running. The installer refuses to install or dry-run");
  console.log("     while the editor is open; close it (and the supervisor) and rerun for a real pass.");
  process.exitCode = 0;
  process.exit();
}

const before = { root: stamp(installRoot), stack: stamp(stackConfig), client: stamp(clientConfig) };

const command = [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-File", installScript,
  "-Project", options.project,
  "-Engine", options.engine,
  "-InstallRoot", installRoot,
  "-DryRun", "-Json", "-NonInteractive", "-Yes",
];
const run = spawnSync("powershell", command, { encoding: "utf8", timeout: 180000 });
const stdout = (run.stdout || "").trim();
const stderr = (run.stderr || "").trim();

check("installer exits 0", run.status === 0, "exit=" + run.status + (run.error ? " error=" + run.error.message : ""));
check("stderr carries the human log", stderr.length > 0, stderr.split(/\r?\n/).slice(0, 1).join(""));

let payload = null;
try {
  payload = JSON.parse(stdout);
  check("stdout is pure JSON", true, stdout.length + " chars");
} catch (error) {
  check("stdout is pure JSON", false, error.message + " | first line: " + stdout.split(/\r?\n/)[0]);
}

if (payload) {
  const dryRun = payload.DryRun === true || payload.dryRun === true;
  check("DryRun flag is true", dryRun, JSON.stringify(payload.DryRun === undefined ? payload.dryRun : payload.DryRun));
  const version = payload.ProductVersion || payload.productVersion;
  const expected = manifest ? manifest.productVersion : "1.7.0";
  check(
    "ProductVersion matches the manifest",
    version === expected,
    "reported " + version + ", expected " + expected + (manifestPath ? " (" + path.basename(path.dirname(manifestPath)) + "/manifest.json)" : " (no manifest beside the installer)"),
  );
  check("DryRun echoes the requested install root", String(payload.InstallRoot || payload.installRoot || "").replace(/\\/g, "/").toLowerCase() === installRoot.replace(/\\/g, "/").toLowerCase(), String(payload.InstallRoot || payload.installRoot));
  check("DryRun names the project", String(payload.Project || payload.project || "").replace(/\\/g, "/").toLowerCase() === options.project.replace(/\\/g, "/").toLowerCase(), String(payload.Project || payload.project));
  check("DryRun names the supervisor pipe", String(payload.SupervisorPipe || payload.supervisorPipe || "").length > 0, String(payload.SupervisorPipe || payload.supervisorPipe));
}

check("install root was not created", stamp(installRoot) === before.root, stamp(installRoot));
check("stack config untouched", stamp(stackConfig) === before.stack, stamp(stackConfig));
check("project client config untouched", stamp(clientConfig) === before.client, stamp(clientConfig));

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log("");
console.log(passed + " passed, 0 skipped, " + failed + " failed");
if (failed > 0) {
  console.log("");
  console.log("stdout:");
  console.log(stdout.slice(0, 2000));
  console.log("stderr:");
  console.log(stderr.slice(0, 2000));
}
process.exitCode = failed > 0 ? 1 : 0;
