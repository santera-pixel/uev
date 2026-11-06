#!/usr/bin/env node
// UEV control-plane latency benchmark.
//
// Measures the control API the way a client feels it: cold start (spawn a control-only
// server and time until /api/health answers), warm ping, catalog, a read action and a
// write action. Every call reports client wall time and the server's own durationMs, so
// transport/JSON overhead is visible separately from engine work.
//
// Usage:
//   node tests/control-latency.mjs                 benchmark the running stack
//   node tests/control-latency.mjs --calls 60 --json latency.json
//   node tests/control-latency.mjs --cold          also measure a cold control-only start
//   node tests/control-latency.mjs --cold-only
//   node tests/control-latency.mjs --descriptor <path> --port <n> --token <token>
//   node tests/control-latency.mjs --cold --root <install-root>   (cold start needs app/ or payload/app under the root)
//   node tests/control-latency.mjs --enforce       exit 1 when a budget is missed
//
// Exit code 1 when the benchmark cannot run at all.

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const hit = args.indexOf(name)
  return hit >= 0 && hit + 1 < args.length ? args[hit + 1] : fallback
}

const callCount = Number(option("--calls", "40"))
const jsonOut = option("--json", "")
const enforce = flag("--enforce")
const doCold = flag("--cold") || flag("--cold-only")
const coldOnly = flag("--cold-only")

const BUDGET = {
  coldFirstPingMs: 1500,
  warmPingP95Ms: 60,
  toolOverheadP95Ms: 100,
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))

const descriptorCandidates = () => {
  const list = []
  if (process.env.UEV_CONTROL_DESCRIPTOR) list.push(process.env.UEV_CONTROL_DESCRIPTOR)
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
  list.push(path.join(localAppData, "UEV", "control.json"))
  return list
}

const resolveTarget = () => {
  const explicitPort = option("--port", "")
  if (explicitPort) {
    return {
      port: Number(explicitPort),
      token: option("--token", process.env.UEV_CONTROL_TOKEN || ""),
      descriptorPath: option("--descriptor", ""),
    }
  }
  for (const candidate of descriptorCandidates()) {
    try {
      const descriptor = readJson(candidate)
      if (Number.isInteger(descriptor.port) && typeof descriptor.token === "string") {
        return { port: descriptor.port, token: descriptor.token, descriptorPath: candidate }
      }
    } catch {
      // try the next candidate
    }
  }
  throw new Error("No control descriptor found. Start the stack or pass --port/--token.")
}

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
  const round = (value) => Math.round(value * 10) / 10
  return {
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  }
}

const timed = async (fn) => {
  const started = process.hrtime.bigint()
  try {
    return { value: await fn(), ms: Number(process.hrtime.bigint() - started) / 1e6 }
  } catch (error) {
    return { error, ms: Number(process.hrtime.bigint() - started) / 1e6 }
  }
}

const makeClient = (target) => {
  const base = "http://127.0.0.1:" + target.port
  const headers = { Authorization: "Bearer " + target.token }
  return {
    async get(pathname) {
      const response = await fetch(base + pathname, { headers })
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = { raw: text } }
      return { status: response.status, body, bytes: Buffer.byteLength(text) }
    },
    async call(tool, action, params) {
      const started = process.hrtime.bigint()
      const response = await fetch(base + "/api/call", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(action === undefined ? { tool, params } : { tool, action, params }),
      })
      const text = await response.text()
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      let body
      try { body = JSON.parse(text) } catch { body = { raw: text } }
      return { status: response.status, body, ms, bytes: Buffer.byteLength(text) }
    },
  }
}

const findServerEntry = (root) => {
  const roots = []
  if (process.env.UEV_APP_ROOT) roots.push(process.env.UEV_APP_ROOT)
  roots.push(path.join(root, "app"), path.join(root, "payload", "app"))
  for (const candidate of roots) {
    const bin = path.join(candidate, "dist", "bin.js")
    if (fs.existsSync(bin)) return bin
  }
  return undefined
}

const findBundledNode = (root) => {
  const candidates = [path.join(root, "node", "node.exe"), path.join(root, "payload", "node", "node.exe")]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return process.execPath
}

const coldStart = async (root) => {
  const bin = findServerEntry(root)
  if (!bin) return { skipped: "server entry not found under <root>/app or <root>/payload/app" }
  const port = 20000 + Math.floor(Math.random() * 20000)
  const descriptorPath = path.join(os.tmpdir(), "uev-latency-cold-" + port + ".json")
  const env = { ...process.env,
    UEV_CONTROL: "1", UEV_CONTROL_PORT: String(port), UEV_CONTROL_TOKEN: "bench-token",
    UEV_CONTROL_DESCRIPTOR: descriptorPath, UEV_PROFILE: "unattended", UEV_SUPERVISOR: "0", UEV_READ_ONLY: "1" }
  const started = process.hrtime.bigint()
  const child = spawn(findBundledNode(root), [bin, "--control"], { env, stdio: ["ignore", "pipe", "pipe"] })
  let stderr = ""
  child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6
  const status = { firstPingMs: undefined, firstCatalogMs: undefined, startup: undefined }
  while (elapsed() < 60000) {
    try {
      const controller = new AbortController()
      const abortTimer = setTimeout(() => controller.abort(), 2000)
      const response = await fetch("http://127.0.0.1:" + port + "/api/health", { headers: { Authorization: "Bearer bench-token" }, signal: controller.signal })
      clearTimeout(abortTimer)
      if (response.status === 200) {
        const body = await response.json()
        status.firstPingMs = elapsed()
        status.startup = body.startup
        break
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (status.firstPingMs !== undefined) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/api/catalog", { headers: { Authorization: "Bearer bench-token" } })
      await response.text()
      status.firstCatalogMs = elapsed()
    } catch { status.firstCatalogMs = undefined }
  }
  child.kill()
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    child.once("exit", () => { clearTimeout(timer); resolve() })
  })
  try { fs.rmSync(descriptorPath, { force: true }) } catch { /* best effort */ }
  status.stderr = stderr.trim().split("\n").slice(-6)
  return status
}

const printReport = (report, notes) => {
  const line = (label, value) => console.log("  " + label.padEnd(24) + value)
  console.log("UEV control-plane latency benchmark")
  console.log("  generated               " + report.generatedAt)
  if (report.descriptor) console.log("  descriptor              " + report.descriptor + " (port " + report.port + ")")
  if (report.identity) console.log("  identity                " + report.identity.productName + " " + report.identity.productVersion + " / server " + report.identity.serverVersion + " / protocol " + report.identity.protocolVersion)
  if (report.startup) console.log("  startup                 " + JSON.stringify(report.startup))
  if (report.cold) {
    if (report.cold.skipped) line("cold start", "SKIP (" + report.cold.skipped + ")")
    else {
      line("cold first ping", Math.round(report.cold.firstPingMs) + " ms")
      if (report.cold.firstCatalogMs) line("cold first catalog", Math.round(report.cold.firstCatalogMs) + " ms")
      if (report.cold.startup) line("cold phases", JSON.stringify(report.cold.startup))
    }
  }
  const table = (label, stat, extra) => {
    if (!stat) return
    const suffix = extra ? "  " + extra : ""
    line(label, "n=" + stat.n + "  p50 " + stat.p50 + "  p95 " + stat.p95 + "  max " + stat.max + " ms" + suffix)
  }
  table("ping /api/health", report.ping)
  table("catalog", report.catalog, report.catalog ? report.catalog.bytes + " bytes" : "")
  table("read manage_actor.list", report.readAction)
  if (report.readAction && report.readAction.server) table("  server durationMs", report.readAction.server)
  table("write spawn PointLight", report.writeAction)
  if (report.writeAction && report.writeAction.server) table("  server durationMs", report.writeAction.server)
  if (report.toolOverheadMs) line("transport overhead", "p50 " + report.toolOverheadMs.p50 + "  p95 " + report.toolOverheadMs.p95 + " ms")
  if (report.verdict) {
    console.log("  budgets:")
    console.log("    first ping <= " + BUDGET.coldFirstPingMs + " ms        " + report.verdict.coldFirstPing)
    console.log("    warm p95 ping <= " + BUDGET.warmPingP95Ms + " ms     " + report.verdict.warmPingP95)
    console.log("    p95 overhead <= " + BUDGET.toolOverheadP95Ms + " ms     " + report.verdict.toolOverheadP95)
  }
  for (const note of notes) console.log("  note: " + note)
}

const finish = (report) => {
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + "\n")
    console.log("  wrote " + jsonOut)
  }
  const verdict = report.verdict || {}
  const miss = Object.keys(verdict).some((key) => verdict[key] === "MISS")
  if (enforce && miss) {
    console.error("budget miss")
    process.exit(1)
  }
  process.exit(0)
}

const main = async () => {
  const explicitRoot = option("--root", "")
  const root = explicitRoot
    ? path.resolve(explicitRoot)
    : path.resolve(path.dirname(new globalThis.URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..")
  const report = { generatedAt: new Date().toISOString(), budget: BUDGET }
  const notes = []
  if (doCold) {
    report.cold = await coldStart(root)
    if (report.cold.firstPingMs !== undefined) notes.push("cold start first ping " + Math.round(report.cold.firstPingMs) + " ms")
  }
  if (coldOnly) { printReport(report, notes); return finish(report) }
  const target = resolveTarget()
  report.descriptor = target.descriptorPath || "(explicit port/token)"
  report.port = target.port
  const client = makeClient(target)
  const healthStarted = await timed(() => client.get("/api/health"))
  if (healthStarted.error || !healthStarted.value || healthStarted.value.status !== 200) throw new Error("control API did not answer /api/health")
  const health = healthStarted.value.body
  report.identity = { productName: health.productName, productVersion: health.productVersion, serverVersion: health.serverVersion, protocolVersion: health.protocolVersion }
  report.startup = health.startup
  const pings = []
  for (let i = 0; i < callCount; i += 1) {
    const result = await timed(() => client.get("/api/health"))
    if (result.error) throw result.error
    pings.push(result.ms)
  }
  report.ping = stats(pings)
  const catalogs = []
  let catalogBytes = 0
  for (let i = 0; i < Math.max(5, Math.round(callCount / 2)); i += 1) {
    const result = await timed(() => client.get("/api/catalog"))
    if (result.error) throw result.error
    catalogs.push(result.ms)
    catalogBytes = result.value.bytes
  }
  report.catalog = Object.assign(stats(catalogs), { bytes: catalogBytes })
  const readResults = []
  const readServer = []
  const readOverhead = []
  for (let i = 0; i < Math.max(5, Math.round(callCount / 2)); i += 1) {
    const result = await client.call("manage_actor", "list", { limit: 1 })
    if (result.status !== 200) throw new Error("manage_actor.list failed: " + JSON.stringify(result.body).slice(0, 300))
    readResults.push(result.ms)
    if (typeof result.body.durationMs === "number") {
      readServer.push(result.body.durationMs)
      readOverhead.push(Math.max(0, result.ms - result.body.durationMs))
    }
  }
  report.readAction = stats(readResults)
  if (readServer.length) report.readAction.server = stats(readServer)
  const writeResults = []
  const writeServer = []
  const writeCount = Math.max(3, Math.round(callCount / 8))
  for (let i = 0; i < writeCount; i += 1) {
    const name = "UEV_LatencyProbe_" + i + "_" + Date.now()
    const spawned = await client.call("manage_actor", "spawn", { actor_type: "/Script/Engine.PointLight", name })
    if (spawned.status !== 200 || spawned.body.ok === false) throw new Error("manage_actor.spawn failed: " + JSON.stringify(spawned.body).slice(0, 300))
    writeResults.push(spawned.ms)
    if (typeof spawned.body.durationMs === "number") writeServer.push(spawned.body.durationMs)
    const deleted = await client.call("manage_actor", "delete", { name })
    if (deleted.status !== 200 || deleted.body.ok === false) throw new Error("manage_actor.delete failed: " + JSON.stringify(deleted.body).slice(0, 300))
  }
  report.writeAction = stats(writeResults)
  if (writeServer.length) report.writeAction.server = stats(writeServer)
  if (readOverhead.length) {
    report.toolOverheadMs = Object.assign(stats(readOverhead), {
      note: "per call: client wall time minus that same call's server durationMs",
    })
  }
  report.verdict = {
    coldFirstPing: report.cold && report.cold.firstPingMs !== undefined ? (report.cold.firstPingMs <= BUDGET.coldFirstPingMs ? "PASS" : "MISS") : "not measured",
    warmPingP95: report.ping.p95 <= BUDGET.warmPingP95Ms ? "PASS" : "MISS",
    toolOverheadP95: !report.toolOverheadMs ? "not measured" : (report.toolOverheadMs.p95 <= BUDGET.toolOverheadP95Ms ? "PASS" : "MISS"),
  }
  printReport(report, notes)
  return finish(report)
}

main().catch((error) => {
  console.error("benchmark failed: " + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
})