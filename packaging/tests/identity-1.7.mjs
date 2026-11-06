#!/usr/bin/env node
/**
 * Identity / clean-break checks for UEV 1.7.0, run against an installed package.
 *
 * Verifies:
 *   1. %LOCALAPPDATA%\UEV owns the runtime, and UEVSupervisor.exe is the only
 *      supervisor binary it holds;
 *   2. the control descriptor and /api/health report the UEV identity on protocol 2;
 *   3. UEV_* environment variables alone drive the control API; a process that sets a
 *      different prefix opens no control API at all;
 *   4. /api/health reports productVersion 1.7.0, and an installed project keeps its
 *      runtime state in Saved\UEV with the UEV plugin folders and .uproject entries.
 *
 * Usage: node tests/identity-1.7.mjs
 * Exit code 0 = all checks passed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const EXPECTED = {
  productName: "UEV",
  productTitle: "UEV - UnrealEngineVite MCP",
  productSlug: "uev",
  productVersion: "1.7.0",
  protocolVersion: 2,
  pipe: "uev-supervisor",
  supervisorExe: "UEVSupervisor.exe",
};

const localAppData = process.env.LOCALAPPDATA || "";
const root = process.env.UEV_INSTALL_ROOT || path.join(localAppData, "UEV");
const nodeExe = process.env.UEV_NODE || path.join(root, "node", "node.exe");
const binJs = path.join(root, "app", "dist", "bin.js");

let failures = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log("PASS " + name + (detail ? " - " + detail : ""));
  else { failures++; console.log("FAIL " + name + (detail ? " - " + detail : "")); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, route, token) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: route, headers: { Authorization: "Bearer " + token }, timeout: 4000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("bad json: " + body.slice(0, 120))); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
  });
}

async function waitForHealth(port, token, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try { return await request(port, "/api/health", token); } catch { await sleep(250); }
  }
  throw new Error("control API did not answer on port " + port);
}

function startServer(env) {
  return spawn(nodeExe, [binJs], { env: { ...process.env, ...env }, stdio: "ignore", windowsHide: true });
}

function assertIdentity(label, health) {
  for (const key of ["productName", "productTitle", "productSlug", "protocolVersion"]) {
    ok(label + " " + key, health[key] === EXPECTED[key], "got " + JSON.stringify(health[key]));
  }
  ok(label + " productVersion", health.productVersion === EXPECTED.productVersion, "got " + JSON.stringify(health.productVersion));
  ok(label + " serverVersion", typeof health.serverVersion === "string" && health.serverVersion.length > 0, "got " + JSON.stringify(health.serverVersion));
}

ok("UEV install root exists", fs.existsSync(binJs), binJs);
ok(
  "install root is the UEV root",
  path.basename(root).toLowerCase() === EXPECTED.productSlug || Boolean(process.env.UEV_INSTALL_ROOT),
  root,
);
const supervisorDir = path.join(root, "supervisor");
const supervisorExes = fs.existsSync(supervisorDir)
  ? fs.readdirSync(supervisorDir).filter((entry) => /\.exe$/i.test(entry))
  : [];
ok("supervisor binary is present", supervisorExes.includes(EXPECTED.supervisorExe), supervisorExes.join(",") || "none");
ok("UEVSupervisor.exe is the only supervisor binary", supervisorExes.length === 1, supervisorExes.join(",") || "none");

const stackConfigPath = path.join(root, "stack.json");
if (fs.existsSync(stackConfigPath)) {
  const stack = JSON.parse(fs.readFileSync(stackConfigPath, "utf8"));
  ok("stack config uses the UEV pipe", stack.pipe === EXPECTED.pipe, "pipe=" + stack.pipe);
  ok(
    "stack config points at the UEV server",
    String(stack.mcpEntry || "").toLowerCase() === path.join(root, "app", "dist", "bin.js").toLowerCase(),
    String(stack.mcpEntry),
  );
} else {
  ok("stack config exists", false, stackConfigPath);
}

const descriptorPath = path.join(root, "control.json");
if (fs.existsSync(descriptorPath)) {
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  ok("descriptor productName", descriptor.productName === EXPECTED.productName, String(descriptor.productName));
  ok("descriptor protocolVersion", descriptor.protocolVersion === EXPECTED.protocolVersion, String(descriptor.protocolVersion));
}

// Native plugin identity. Pass --project <path-to-.uproject> to check an installed project.
const projectIndex = process.argv.indexOf("--project");
const projectFile = projectIndex > 0 ? process.argv[projectIndex + 1] : "";
if (projectFile) {
  const projectDir = path.dirname(projectFile);
  for (const name of ["UEVNative", "UEVControlPanel"]) {
    ok(name + " plugin folder", fs.existsSync(path.join(projectDir, "Plugins", name)));
  }
  ok("project data directory is UEV", fs.existsSync(path.join(projectDir, "Saved", "UEV")), path.join(projectDir, "Saved", "UEV"));
  const launcherPath = path.join(projectDir, "Saved", "UEV", "run-stack.ps1");
  if (fs.existsSync(launcherPath)) {
    const launcherText = fs.readFileSync(launcherPath, "utf8");
    ok("launcher starts the UEV supervisor pipe", /uev-supervisor/i.test(launcherText), launcherPath);
  }
  const pluginDir = path.join(projectDir, "Plugins");
  const pluginFolders = fs.existsSync(pluginDir) ? fs.readdirSync(pluginDir) : [];
  ok("project plugins are UEV-only", pluginFolders.every((entry) => !/^MCP/i.test(entry)), pluginFolders.join(","));
  ok("UEVNative editor binary", fs.existsSync(path.join(projectDir, "Plugins", "UEVNative", "Binaries", "Win64", "UE4Editor-UEVNative.dll")));
  ok("UEVControlPanel editor binary", fs.existsSync(path.join(projectDir, "Plugins", "UEVControlPanel", "Binaries", "Win64", "UE4Editor-UEVControlPanel.dll")));
  if (fs.existsSync(projectFile)) {
    const uproject = JSON.parse(fs.readFileSync(projectFile, "utf8"));
    const names = (uproject.Plugins || []).map((entry) => String(entry.Name));
    ok(".uproject enables UEVNative", names.includes("UEVNative"), names.join(","));
    ok(".uproject plugin entries are UEV-only", names.every((name) => !/^MCP/i.test(name)), names.join(","));
  } else {
    ok("project file exists", false, projectFile);
  }
}

const tmp = os.tmpdir();

// 1.7.0 clean break: UEV_* alone must be enough.
{
  const child = startServer({
    UEV_CONTROL: "1",
    UEV_CONTROL_PORT: "8802",
    UEV_PROFILE: "supervised",
    UEV_SUPERVISOR: "0",
    UEV_CONTROL_TOKEN: "uev-token",
    UEV_CONTROL_DESCRIPTOR: path.join(tmp, "uev-identity-descriptor.json"),
  });
  try {
    const health = await waitForHealth(8802, "uev-token");
    assertIdentity("UEV_* only", health);
  } catch (error) {
    ok("UEV_* only", false, error.message);
  } finally {
    if (!child.killed) child.kill();
    await sleep(400);
  }
}

// The control API is gated on UEV_*: another prefix opens nothing, even when complete.
{
  const child = startServer({
    UEV_CONTROL: "",
    UEV_CONTROL_PORT: "",
    UEV_PROFILE: "",
    UEV_SUPERVISOR: "",
    UEV_CONTROL_TOKEN: "",
    UEV_CONTROL_DESCRIPTOR: "",
    OTHERAPP_CONTROL: "1",
    OTHERAPP_CONTROL_PORT: "8806",
    OTHERAPP_CONTROL_TOKEN: "wrong-token",
    OTHERAPP_CONTROL_DESCRIPTOR: path.join(tmp, "uev-otherapp-ignored.json"),
  });
  try {
    let answered = null;
    try { answered = await waitForHealth(8806, "wrong-token", 8); } catch { answered = null; }
    ok("non-UEV prefix opens no control API", answered === null, answered ? "control API answered on 8806" : "no control API without UEV_*");
  } finally {
    if (!child.killed) child.kill();
    await sleep(400);
  }
}

console.log(failures === 0 ? "\nidentity checks passed" : "\n" + failures + " identity check(s) failed");
process.exit(failures === 0 ? 0 : 1);
