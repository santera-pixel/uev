#!/usr/bin/env node
/**
 * Stable object handle regression suite for UEV 1.6.x.
 *
 * Proves that a handle taken from one call still targets the same object after
 * actors are added and removed, after the native retained-object registry is
 * released, and that a handle whose object is gone fails with a structured
 * handle_stale error instead of silently resolving to something else.
 *
 * Usage:
 *   node tests/stable-handles.mjs            # live stack via the control descriptor
 *   node tests/stable-handles.mjs --descriptor <path> --port <n> --token <token>
 *
 * Exit code 0 = every check behaved, 1 = at least one failure.
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const hit = args.indexOf(name)
  return hit >= 0 && hit + 1 < args.length ? args[hit + 1] : fallback
}
const localAppData = process.env.LOCALAPPDATA ?? ''

const results = []
function record(name, status, detail) {
  results.push({ name, status, detail })
  const tag = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL'
  console.log(tag + '  ' + name + (detail ? ' -- ' + detail : ''))
}

function descriptorCandidates() {
  return [
    option('--descriptor', ''),
    process.env.UEV_CONTROL_DESCRIPTOR,
    localAppData ? path.join(localAppData, 'UEV', 'control.json') : undefined,
  ].filter(Boolean)
}

function readDescriptor() {
  const explicitPort = option('--port', '')
  if (explicitPort) {
    return { port: Number(explicitPort), token: option('--token', '') }
  }
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

async function call(descriptor, tool, action, params = {}, timeoutMs = 120000) {
  const response = await fetch('http://127.0.0.1:' + descriptor.port + '/api/call', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + descriptor.token, 'Content-Type': 'application/json' },
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

function check(name, ok, detail) {
  record(name, ok ? 'PASS' : 'FAIL', detail)
  return ok
}

async function spawnProbe(descriptor, suffix) {
  const name = 'UEV_HandleProbe_' + suffix + '_' + Date.now()
  const spawned = await call(descriptor, 'manage_actor', 'spawn', {
    actor_type: '/Script/Engine.PointLight',
    name,
  })
  if (!spawned || spawned.success === false) {
    throw new Error('could not spawn probe actor: ' + JSON.stringify(spawned).slice(0, 300))
  }
  return name
}

async function describeByHandle(descriptor, handle) {
  return await call(descriptor, 'manage_object', 'describe', { handle, values: false })
}

async function main() {
  const descriptor = readDescriptor()
  const health = await (await fetch('http://127.0.0.1:' + descriptor.port + '/api/health', {
    headers: { Authorization: 'Bearer ' + descriptor.token },
    signal: AbortSignal.timeout(10000),
  })).json()
  console.log(
    (health.productName || 'UEV') + ' ' + health.productVersion + ' (server ' + health.serverVersion + ', protocol ' + health.protocolVersion + ') via ' + (descriptor.descriptorPath || ('port ' + descriptor.port)),
  )

  // 1. Namespace description advertises the handle grammar.
  const catalog = await (await fetch('http://127.0.0.1:' + descriptor.port + '/api/catalog', {
    headers: { Authorization: 'Bearer ' + descriptor.token },
  })).json()
  const queryTool = (catalog.tools || []).find((tool) => tool.name === 'manage_query')
  const objectTool = (catalog.tools || []).find((tool) => tool.name === 'manage_object')
  const queryAction = (queryTool?.actions || []).find((action) => action.name === 'query')
  const handleParam = (objectTool?.actions || [])
    .flatMap((action) => action.params || [])
    .find((param) => param.name === 'handle')
  check(
    'catalog documents the handle input',
    Boolean(queryAction && handleParam),
    'manage_query.query=' + Boolean(queryAction) + ' manage_object handle param=' + Boolean(handleParam),
  )

  // 2. Query results carry a stable handle (any actor anchors the test).
  let first
  let queryLabel = ''
  for (const selector of [{ class: 'PointLight' }, { class: 'Light' }, { class: 'Actor' }]) {
    const query = await call(descriptor, 'manage_query', 'query', { ...selector, limit: 5 })
    const candidate = (query.objects || [])[0]
    if (candidate) {
      first = candidate
      queryLabel = JSON.stringify(selector)
      break
    }
  }
  if (!first) {
    record('query returns a stable handle', 'SKIP', 'no actor in the level to anchor the test')
    const failedEarly = results.filter((entry) => entry.status === 'FAIL').length
    process.exit(failedEarly > 0 ? 1 : 0)
  }
  const stableHandle = first.handle
  const nativeHandle = first.native_handle
  const originalPath = first.path
  record('anchor', 'PASS', 'query ' + queryLabel + ' -> ' + String(first.path).slice(0, 120))
  check(
    'query returns a stable uev: handle',
    typeof stableHandle === 'string' && stableHandle.startsWith('uev:'),
    String(stableHandle).slice(0, 120),
  )
  check(
    'query also returns the legacy native handle',
    typeof nativeHandle === 'string' && nativeHandle.startsWith('obj_'),
    String(nativeHandle),
  )

  // 3. Drift scenario: add and remove actors, release the registry, retarget.
  const spawned = []
  for (let i = 0; i < 3; i += 1) {
    spawned.push(await spawnProbe(descriptor, 'drift' + i))
  }
  for (const name of spawned.slice(0, 2)) {
    const removed = await call(descriptor, 'manage_actor', 'delete', { name })
    if (!removed || removed.success === false) {
      record('probe cleanup', 'SKIP', 'could not delete ' + name)
    }
  }
  const released = await call(descriptor, 'manage_object', 'release_handles', {})
  check(
    'release_handles reports a registry generation',
    Boolean(released && released.success !== false && typeof released.generation === 'number'),
    released ? 'generation=' + released.generation + ' prefix=' + released.stable_handle_prefix : 'no result',
  )

  // 4. The stable handle still resolves to the original object after the drift.
  const afterDrift = await describeByHandle(descriptor, stableHandle)
  const afterPath = afterDrift?.object?.path
  check(
    'stable handle survives add/remove plus registry release',
    Boolean(afterDrift && afterDrift.success !== false && afterPath === originalPath),
    'expected ' + originalPath + '; got ' + String(afterPath).slice(0, 140),
  )

  // 5. Legacy obj_N may drift now; report it as evidence, never as a failure of the stable path.
  if (nativeHandle) {
    const nativeAfter = await describeByHandle(descriptor, nativeHandle)
    const nativePath = nativeAfter?.object?.path
    if (nativeAfter && nativeAfter.success !== false) {
      record(
        'legacy obj_N after release',
        'PASS',
        nativePath === originalPath
          ? 'still resolved to the same object (' + nativePath + ')'
          : 'drifted to ' + String(nativePath).slice(0, 140) + ' -- this is the defect the stable handle removes',
      )
    } else {
      record('legacy obj_N after release', 'PASS', 'refused with ' + (nativeAfter?.code ?? 'an error') + ' instead of resolving to a different object')
    }
  }

  // 6. A handle whose object is gone fails with handle_stale.
  const doomed = await spawnProbe(descriptor, 'stale')
  const doomedQuery = await call(descriptor, 'manage_query', 'query', { label: doomed, limit: 1 })
  const doomedEntry = (doomedQuery.objects || [])[0]
  const doomedHandle = doomedEntry?.handle
  if (!doomedHandle) {
    record('stale handle is refused', 'SKIP', 'query could not find the probe actor label')
  } else {
    const destroyed = await call(descriptor, 'manage_actor', 'delete', { name: doomed })
    if (!destroyed || destroyed.success === false) {
      record('stale handle is refused', 'SKIP', 'could not delete the probe actor')
    } else {
      const stale = await describeByHandle(descriptor, doomedHandle)
      check(
        'stale handle is refused with handle_stale',
        Boolean(stale && stale.success === false && stale.code === 'handle_stale'),
        stale ? 'code=' + String(stale.code) + ' message=' + String(stale.message).slice(0, 120) : 'no result',
      )
    }
  }

  // 7. The legacy obj_N input is still accepted for a live object.
  const live = await spawnProbe(descriptor, 'legacy')
  const liveQuery = await call(descriptor, 'manage_query', 'query', { label: live, limit: 1 })
  const liveEntry = (liveQuery.objects || [])[0]
  if (liveEntry?.native_handle) {
    const viaNative = await describeByHandle(descriptor, liveEntry.native_handle)
    check(
      'legacy obj_N still accepted for a live object',
      Boolean(viaNative && viaNative.success !== false && viaNative.object?.path === liveEntry.path),
      'via ' + liveEntry.native_handle,
    )
  } else {
    record('legacy obj_N still accepted for a live object', 'SKIP', 'no native handle returned')
  }
  await call(descriptor, 'manage_actor', 'delete', { name: live })

  const failed = results.filter((entry) => entry.status === 'FAIL').length
  const skipped = results.filter((entry) => entry.status === 'SKIP').length
  console.log('')
  console.log(results.length - failed - skipped + ' passed, ' + skipped + ' skipped, ' + failed + ' failed')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('stable-handles suite failed: ' + (error && error.message ? error.message : error))
  process.exit(1)
})
