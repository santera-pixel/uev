#!/usr/bin/env node
/**
 * Crash-guard regression suite for UEV 1.6.x.
 *
 * Exercises every enforced crash guard that can be reached over the control API,
 * plus one induced crash to prove the supervisor watchdog brings the stack back.
 *
 * Usage:
 *   node tests/crash-guards.mjs              # full run (includes the induced crash)
 *   node tests/crash-guards.mjs --skip-crash # refusals only, leaves the editor running
 *
 * Exit code 0 = every checked guard behaved, 1 = at least one failure.
 * Behaviour that cannot be exercised on this machine is reported as SKIP, never PASS.
 */
import fs from 'node:fs'
import path from 'node:path'

const args = new Set(process.argv.slice(2))
const skipCrash = args.has('--skip-crash')
const localAppData = process.env.LOCALAPPDATA ?? ''

const results = []
function record(name, status, detail) {
  results.push({ name, status, detail })
  const tag = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL'
  console.log(tag + '  ' + name + (detail ? ' -- ' + detail : ''))
}

function descriptorCandidates() {
  return [
    process.env.UEV_CONTROL_DESCRIPTOR,
    localAppData ? path.join(localAppData, 'UEV', 'control.json') : undefined,
  ].filter(Boolean)
}

function readDescriptor() {
  for (const candidate of descriptorCandidates()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      if (parsed.port && parsed.token) {
        return { ...parsed, descriptorPath: candidate }
      }
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('No control descriptor found. Tried: ' + descriptorCandidates().join(', '))
}

function controlUrl(descriptor) {
  return 'http://127.0.0.1:' + descriptor.port
}

async function controlCall(descriptor, tool, action, params = {}, timeoutMs = 120000) {
  const response = await fetch(controlUrl(descriptor) + '/api/call', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + descriptor.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tool, action, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return { success: false, raw: text, httpStatus: response.status }
  }
  if (payload && typeof payload.text === 'string') {
    try {
      return JSON.parse(payload.text)
    } catch {
      return { success: false, raw: payload.text, httpStatus: response.status }
    }
  }
  return payload
}

async function health(descriptor, timeoutMs = 10000) {
  const response = await fetch(controlUrl(descriptor) + '/api/health', {
    headers: { Authorization: 'Bearer ' + descriptor.token },
    signal: AbortSignal.timeout(timeoutMs),
  })
  return await response.json()
}

function isRefusal(result, guardId) {
  if (!result || result.success !== false) {
    return false
  }
  if (guardId && result.error?.guard !== guardId) {
    return false
  }
  return result.error?.code === 'unsafe_operation_refused'
}

function newestSupervisorLog() {
  const logDir = localAppData ? path.join(localAppData, 'UEV', 'logs') : ''
  if (!logDir || !fs.existsSync(logDir)) {
    return undefined
  }
  const logs = fs
    .readdirSync(logDir)
    .filter((name) => name.startsWith('supervisor-') && name.endsWith('.log'))
    .map((name) => {
      const full = path.join(logDir, name)
      return { full, mtime: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return logs[0]?.full
}

async function waitForPie(descriptor, wanted, attempts = 45) {
  for (let i = 0; i < attempts; i++) {
    try {
      const state = await controlCall(descriptor, 'manage_editor', 'is_pie_running', {}, 30000)
      if (Boolean(state.is_pie_running) === wanted) {
        return state
      }
    } catch {
      /* editor busy while transitioning */
    }
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  return undefined
}

function dllContains(filePath, needle) {
  try {
    const bytes = fs.readFileSync(filePath)
    // UE string literals land in the binary as UTF-16LE; some log text is UTF-8.
    return (
      bytes.includes(Buffer.from(needle, 'utf16le')) || bytes.toString('latin1').includes(needle)
    )
  } catch {
    return false
  }
}

const descriptor = readDescriptor()
const identity = await health(descriptor)
console.log(
  'UEV ' + identity.productVersion + ' (server ' + identity.serverVersion + ', protocol ' + identity.protocolVersion + ') via ' + descriptor.descriptorPath,
)
if (identity.protocolVersion !== 2) {
  record('protocol version', 'FAIL', 'expected 2, got ' + identity.protocolVersion)
}

// ---------------------------------------------------------------- protected content
async function expectRefusal(name, guardId, run) {
  try {
    const result = await run()
    if (isRefusal(result, guardId)) {
      record(name, 'PASS', result.message)
    } else {
      record(name, 'FAIL', JSON.stringify(result).slice(0, 300))
    }
  } catch (error) {
    record(name, 'FAIL', String(error))
  }
}

await expectRefusal('protected-content: refuse delete of /Game', 'protected-content', () =>
  controlCall(descriptor, 'manage_asset', 'delete', { path: '/Game' }),
)
await expectRefusal('protected-content: refuse delete of /Engine', 'protected-content', () =>
  controlCall(descriptor, 'manage_asset', 'delete', { path: '/Engine/EngineMaterials/DefaultMaterial' }),
)

// ---------------------------------------------------------------- PIE editor mutations
let pieStarted = false
try {
  await controlCall(descriptor, 'manage_editor', 'start_pie', {})
  pieStarted = Boolean(await waitForPie(descriptor, true))
} catch (error) {
  record('pie-editor-mutation: start PIE', 'SKIP', String(error))
}

if (pieStarted) {
  await expectRefusal('pie-editor-mutation: refuse spawn_actor', 'pie-editor-mutation', () =>
    controlCall(descriptor, 'manage_actor', 'spawn', { actor_type: '/Script/Engine.PointLight', name: 'UEV_GuardProbe' }),
  )
  await expectRefusal('pie-editor-mutation: refuse delete actor', 'pie-editor-mutation', () =>
    controlCall(descriptor, 'manage_actor', 'delete', { name: 'UEV_GuardProbe' }),
  )
  await expectRefusal('pie-editor-mutation: refuse delete_folder', 'pie-editor-mutation', () =>
    controlCall(descriptor, 'manage_asset', 'delete_folder', { path: '/Game/__UEV_GuardProbe' }),
  )
  await expectRefusal('pie-editor-mutation: refuse blueprint compile', 'pie-editor-mutation', () =>
    controlCall(descriptor, 'manage_blueprint', 'compile', { blueprint_name: '/Game/ThirdPersonCPP/Blueprints/ThirdPersonCharacter' }),
  )
  try {
    await controlCall(descriptor, 'manage_editor', 'stop_pie', {})
    await waitForPie(descriptor, false)
  } catch {
    /* stop is best effort */
  }
} else {
  record('pie-editor-mutation: refuse spawn_actor', 'SKIP', 'PIE did not start')
  record('pie-editor-mutation: refuse delete actor', 'SKIP', 'PIE did not start')
  record('pie-editor-mutation: refuse delete_folder', 'SKIP', 'PIE did not start')
  record('pie-editor-mutation: refuse blueprint compile', 'SKIP', 'PIE did not start')
}

// ---------------------------------------------------------------- unplaceable blueprint
const unplaceable = process.env.UEV_TEST_UNPLACEABLE_BP
if (unplaceable) {
  try {
    const result = await controlCall(descriptor, 'manage_actor', 'spawn_blueprint', { blueprint_name: unplaceable })
    const refused = result?.success === false && typeof result.message === 'string' && /not placeable/i.test(result.message)
    if (refused) {
      record('unplaceable-blueprint: refuse spawn', 'PASS', result.message)
    } else {
      record('unplaceable-blueprint: refuse spawn', 'FAIL', JSON.stringify(result).slice(0, 300))
    }
  } catch (error) {
    record('unplaceable-blueprint: refuse spawn', 'FAIL', String(error))
  }
} else {
  record(
    'unplaceable-blueprint: refuse spawn',
    'SKIP',
    'set UEV_TEST_UNPLACEABLE_BP to a controller/game-mode blueprint path to exercise this guard',
  )
}

// ---------------------------------------------------------------- panel reentrancy (compiled-in strings)
{
  const dllCandidates = [
    'D:\\Uprojects\\mcptest2\\Plugins\\UEVControlPanel\\Binaries\\Win64\\UE4Editor-UEVControlPanel.dll',
    localAppData ? path.join(localAppData, 'UEV', 'plugins', 'UEVControlPanel', 'Binaries', 'Win64', 'UE4Editor-UEVControlPanel.dll') : undefined,
  ].filter(Boolean)
  const found = dllCandidates.find(
    (candidate) =>
      dllContains(candidate, 'panel-reentrancy crash guard') &&
      dllContains(candidate, 'nested tool row rebuild skipped'),
  )
  if (found) {
    record('panel-reentrancy: guards compiled into the panel', 'PASS', found)
  } else {
    record(
      'panel-reentrancy: guards compiled into the panel',
      'FAIL',
      'no panel binary containing the guard strings; tried ' + dllCandidates.join(', '),
    )
  }
}

// ---------------------------------------------------------------- crash watchdog
if (skipCrash) {
  record('crash-watchdog: restart after induced crash', 'SKIP', '--skip-crash')
} else {
  const logPath = newestSupervisorLog()
  if (!logPath) {
    record('crash-watchdog: restart after induced crash', 'FAIL', 'no supervisor log found under %LOCALAPPDATA%\\UEV\\logs')
  } else {
    const before = fs.readFileSync(logPath, 'utf8')
    if (!/watchdog: restartOnCrash=True/.test(before)) {
      record(
        'crash-watchdog: restart after induced crash',
        'FAIL',
        'supervisor log ' + logPath + ' does not report watchdog: restartOnCrash=True (old supervisor binary?)',
      )
    } else {
      console.log('... inducing a crash via manage_editor.run_python (editor exits with code 3)')
      try {
        await controlCall(descriptor, 'manage_editor', 'run_python', { code: 'import os\nos._exit(3)\n' }, 15000)
      } catch {
        /* the connection dies with the editor; that is the point */
      }

      let recovered
      const deadline = Date.now() + 240000
      while (Date.now() < deadline) {
        try {
          const fresh = readDescriptor()
          const state = await health(fresh, 5000)
          if (state.ok && state.productVersion) {
            recovered = state
            break
          }
        } catch {
          /* still restarting */
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }

      const after = fs.readFileSync(logPath, 'utf8')
      const tail = after.slice(before.length)
      const sawCrash = /watchdog: crash detected \(child exit=3\)/.test(tail)
      const sawRestart = /crash detected \(child exit=3\); restart \d+\/\d+/.test(tail)
      if (recovered && sawCrash && sawRestart) {
        record(
          'crash-watchdog: restart after induced crash',
          'PASS',
          'editor exit=3 -> watchdog restart -> UEV ' + recovered.productVersion + ' healthy again',
        )
      } else {
        record(
          'crash-watchdog: restart after induced crash',
          'FAIL',
          'recovered=' + Boolean(recovered) + ' crashDetected=' + sawCrash + ' restartLogged=' + sawRestart + '; log ' + logPath,
        )
      }
    }
  }
}

const failures = results.filter((entry) => entry.status === 'FAIL')
const skips = results.filter((entry) => entry.status === 'SKIP')
console.log('')
console.log(results.length - failures.length - skips.length + ' passed, ' + skips.length + ' skipped, ' + failures.length + ' failed')
process.exit(failures.length === 0 ? 0 : 1)
