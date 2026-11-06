#!/usr/bin/env node
// UEV 1.6 API-consistency regression test.
// Covers: inherited function calls on manage_object.call, unified widget targeting
// aliases, material-instance static switch writes (native UEVMaterial module), and
// graph_name parity across add_node / connect_nodes / disconnect_nodes / delete_node.
//
// Usage: node api-consistency.mjs [--descriptor <control.json>] [--port 8765] [--token <token>]

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : undefined
}

function descriptorCandidates() {
  const list = []
  if (opt('descriptor')) list.push(opt('descriptor'))
  const env = process.env
  const roots = [env.LOCALAPPDATA, env.APPDATA].filter(Boolean)
  for (const root of roots) {
    list.push(path.join(root, 'UEV', 'control.json'))
  }
  return list
}

let descriptor = null
for (const candidate of descriptorCandidates()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
    if (parsed.port && parsed.token) {
      descriptor = { ...parsed, source: candidate }
      break
    }
  } catch {}
}
if (!descriptor) {
  console.error('FAIL cannot find a control descriptor; pass --descriptor <control.json>')
  process.exitCode = 1
  throw new Error('no descriptor')
}

const baseUrl = 'http://127.0.0.1:' + (opt('port') ?? descriptor.port)
const token = opt('token') ?? descriptor.token

async function call(tool, action, params = {}) {
  const response = await fetch(baseUrl + '/api/call', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, action, params }),
    signal: AbortSignal.timeout(180000),
  })
  const envelope = await response.json()
  const raw = envelope?.text ?? envelope
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return { raw }
    }
  }
  return raw
}

let passed = 0
let failed = 0
let skipped = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  PASS ' + name)
  } else {
    failed += 1
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
    failures.push(name + ' :: ' + (text ?? '').slice(0, 400))
    console.log('  FAIL ' + name + (text ? ' :: ' + text.slice(0, 400) : ''))
  }
}
function skip(name, why) {
  skipped += 1
  console.log('  SKIP ' + name + ' :: ' + why)
}
function section(title) {
  console.log('\n## ' + title)
}

const PY_FIXTURE = `
import unreal
pkg = '/Game/UEVTests'
if not unreal.EditorAssetLibrary.does_directory_exist(pkg):
    unreal.EditorAssetLibrary.make_directory(pkg)
path = pkg + '/M_UEV_SwitchFixture'
lib = unreal.MaterialEditingLibrary
if unreal.EditorAssetLibrary.does_asset_exist(path):
    mat = unreal.EditorAssetLibrary.load_asset(path)
else:
    mat = unreal.AssetToolsHelpers.get_asset_tools().create_asset('M_UEV_SwitchFixture', pkg, unreal.Material, unreal.MaterialFactoryNew())
names = [str(n) for n in lib.get_static_switch_parameter_names(mat)]
if 'UEVSwitch' not in names:
    sw = lib.create_material_expression(mat, unreal.MaterialExpressionStaticSwitchParameter, -600, 0)
    sw.set_editor_property('parameter_name', 'UEVSwitch')
    sw.set_editor_property('default_value', False)
    lib.connect_material_property(sw, '', unreal.MaterialProperty.MP_BASE_COLOR)
lib.recompile_material(mat)
unreal.EditorAssetLibrary.save_loaded_asset(mat)
print('FIXTURE ' + mat.get_path_name())
print('NATIVE ' + str(hasattr(unreal, 'UEVMaterialLibrary')))
print('SWITCHES ' + repr([str(n) for n in lib.get_static_switch_parameter_names(mat)]))
`

// ---------------------------------------------------------------- setup
section('health')
const health = await fetch(baseUrl + '/api/health', {
  headers: { Authorization: 'Bearer ' + token },
  signal: AbortSignal.timeout(20000),
}).then((r) => r.json())
check('control API identifies as UEV 1.7.0', health.productName === 'UEV' && health.productVersion === '1.7.0', {
  productName: health.productName,
  productVersion: health.productVersion,
})
check('protocol 2', health.protocolVersion === 2, health.protocolVersion)

section('fixtures')
const fixture = await call('manage_editor', 'run_python', { code: PY_FIXTURE })
const fixtureText = JSON.stringify(fixture)
check('material fixture authored', fixtureText.includes('/Game/UEVTests/M_UEV_SwitchFixture'), fixtureText.slice(0, 300))
check('native UEVMaterial module loaded', fixtureText.includes('NATIVE True'), fixtureText.slice(0, 300))

const created = await call('manage_material', 'create_material_instance', {
  parent_material: '/Game/UEVTests/M_UEV_SwitchFixture',
  instance_name: 'MI_UEV_SwitchFixture',
  package_path: '/Game/UEVTests',
})
const existing = (created.message ?? '').toLowerCase().includes('exist')
check('material instance available', created.success === true || existing, created)

const widgetBlueprint = '/Game/UEVTests/WBP_UEVApiWidget'
const widgetProbe = await call('manage_query', 'query', { path: widgetBlueprint, limit: 1 })
if (!widgetProbe || !JSON.stringify(widgetProbe).includes('WBP_UEVApiWidget')) {
  await call('manage_widget', 'create_widget_blueprint', { widget_name: widgetBlueprint, path: '/Game/UEVTests' })
  await call('manage_widget', 'add_button', { widget_blueprint: widgetBlueprint, button_name: 'UEVButton', text: 'Click' })
}

const spawned = await call('manage_actor', 'spawn', {
  actor_type: '/Script/Engine.PointLight',
  name: 'UEV_ApiConsistencyProbe',
})
check('probe actor spawned', spawned.success !== false, spawned)
const queried = await call('manage_query', 'query', {
  label: 'UEV_ApiConsistencyProbe',
  limit: 5,
})
const probe = (queried.objects ?? []).find((o) => (o.label ?? o.path_name ?? '').includes('UEV_ApiConsistencyProbe'))
const probeHandle = probe?.handle
check('probe actor handle resolved', typeof probeHandle === 'string' && probeHandle.startsWith('uev:'), probe)

// ------------------------------------------------- 1. inherited resolution
section('inherited function resolution (manage_object.call)')
const inherited = await call('manage_object', 'call', {
  handle: probeHandle,
  function: 'GetActorLocation',
})
check('inherited AActor function callable by blueprint name', inherited.success === true, inherited)
check('resolved through the K2 alias', inherited.resolution === 'alias_k2' || inherited.function === 'K2_GetActorLocation', inherited)

const explicitK2 = await call('manage_object', 'call', {
  handle: probeHandle,
  function: 'K2_GetActorLocation',
})
check('K2_ name resolves exactly', explicitK2.success === true && explicitK2.resolution === 'exact', explicitK2)

const typo = await call('manage_object', 'call', {
  handle: probeHandle,
  function: 'GetActorLocaton',
})
const suggestions = typo.suggestions ?? []
check('typo reports not_found', typo.success === false && typo.code === 'not_found', typo)
check('typo suggests the inherited function', suggestions.some((s) => String(s).includes('GetActorLocation')), {
  suggestions,
  message: typo.message,
})

// ------------------------------------------------------- 2. widget aliases
section('unified widget targeting aliases')
const memberCall = await call('manage_widget', 'bind_event', {
  widget_blueprint: widgetBlueprint,
  widget_member_name: 'UEVButton',
  event_name: 'OnClicked',
  function_name: 'OnUEVConsistencyMember',
})
check('bind_event accepts widget_member_name', memberCall.success === true, memberCall)

const legacyCall = await call('manage_widget', 'bind_event', {
  widget_blueprint: widgetBlueprint,
  widget_name: 'UEVButton',
  event_name: 'OnClicked',
  function_name: 'OnUEVConsistencyLegacy',
})
check('bind_event accepts widget_name alias', legacyCall.success === true, legacyCall)

const slotMember = await call('manage_widget', 'set_slot', {
  widget_blueprint: widgetBlueprint,
  widget_member_name: 'UEVButton',
  z_order: 2,
})
check('set_slot accepts widget_member_name', slotMember.success === true, slotMember)

const propertyMember = await call('manage_widget', 'set_widget_property', {
  widget_blueprint: widgetBlueprint,
  widget_member_name: 'UEVButton',
  property: 'is_enabled',
  value: true,
})
check('set_widget_property accepts widget_member_name', propertyMember.success === true, propertyMember)

for (const [action, params] of [
  ['bind_event', { event_name: 'OnClicked' }],
  ['set_slot', { z_order: 1 }],
  ['set_widget_property', { property: 'is_enabled', value: true }],
]) {
  const conflict = await call('manage_widget', action, {
    widget_blueprint: widgetBlueprint,
    widget_member_name: 'UEVButton',
    widget_name: 'OtherButton',
    ...params,
  })
  const message = String(conflict.message ?? conflict.raw ?? '')
  check(action + ' rejects a conflicting alias pair', conflict.success === false && message.includes('conflicts with widget_name'), conflict)
}

// -------------------------------------------------------- 3. static switch
section('material instance static switch (native writer)')
// Reads reset the supervised circuit breaker; earlier deliberate-failure checks may have opened it.
await call('manage_material', 'inspect_material_instance', { asset_path: '/Game/UEVTests/MI_UEV_SwitchFixture' })
const switchOn = await call('manage_material', 'set_material_instance_parameter', {
  asset_path: '/Game/UEVTests/MI_UEV_SwitchFixture',
  parameter_name: 'UEVSwitch',
  parameter_type: 'static_switch',
  value: true,
})
check('static switch accepts true', switchOn.success === true, switchOn)

const inspected = await call('manage_material', 'inspect_material_instance', {
  asset_path: '/Game/UEVTests/MI_UEV_SwitchFixture',
})
const overrides = inspected.static_switch_overrides ?? {}
check('override is reported as overridden', overrides.UEVSwitch === true, inspected.static_switch_overrides)
check('effective value follows the write', inspected.static_switch_parameters?.UEVSwitch === true, inspected.static_switch_parameters)

const switchBatch = await call('manage_material', 'set_material_instance_parameters', {
  asset_path: '/Game/UEVTests/MI_UEV_SwitchFixture',
  static_switches: { UEVSwitch: false },
})
check('batch static_switches write works', switchBatch.success === true, switchBatch)
const inspectedBatch = await call('manage_material', 'inspect_material_instance', {
  asset_path: '/Game/UEVTests/MI_UEV_SwitchFixture',
})
check(
  'batch write lands in the instance',
  inspectedBatch.static_switch_parameters?.UEVSwitch === false && inspectedBatch.static_switch_overrides?.UEVSwitch === true,
  { parameters: inspectedBatch.static_switch_parameters, overrides: inspectedBatch.static_switch_overrides },
)

const switchBad = await call('manage_material', 'set_material_instance_parameter', {
  asset_path: '/Game/UEVTests/MI_UEV_SwitchFixture',
  parameter_name: 'UEVSwitch',
  parameter_type: 'static_switch',
  value: 'banana',
})
check(
  'invalid switch value is rejected with guidance',
  switchBad.success === false && String(switchBad.message ?? '').includes('expects true or false'),
  switchBad,
)

await call('manage_material', 'inspect_material_instance', { asset_path: '/Game/UEVTests/MI_UEV_SwitchFixture' })

// --------------------------------------------------------- 4. graph_name
section('graph_name parity across graph actions')
const bogus = 'NoSuchGraph_UEV'
const graphCalls = {
  inspect_graph: { graph_name: bogus, include_nodes: false },
  add_node: { graph_name: bogus, node_type: 'comment', comment: 'uev' },
  connect_nodes: { graph_name: bogus, source_node_id: 'x', source_pin: 'then', target_node_id: 'y', target_pin: 'execute' },
  disconnect_nodes: { graph_name: bogus, source_node_id: 'x', source_pin: 'then' },
  delete_node: { graph_name: bogus, node_id: 'x' },
}
for (const [action, params] of Object.entries(graphCalls)) {
  const result = await call('manage_blueprint', action, { blueprint_name: widgetBlueprint, ...params })
  const message = String(result.message ?? result.error ?? result.raw ?? '')
  check(action + ' honours graph_name (same not-found text)', message.includes('Graph not found: ' + bogus), result)
}

const plainBlueprint = '/Game/UEVTests/BP_UEVGraphNameProbe'
await call('manage_blueprint', 'create_blueprint', { blueprint_name: plainBlueprint, parent_class: 'Actor', path: '/Game/UEVTests' })
const ucsNode = await call('manage_blueprint', 'add_node', {
  blueprint_name: plainBlueprint,
  graph_name: 'UserConstructionScript',
  node_type: 'comment',
  comment: 'UEV graph_name parity',
})
check('add_node accepts the UserConstructionScript alias', ucsNode.success !== false, ucsNode)
const ucsNodeId = ucsNode.node_id ?? ucsNode.node?.id ?? ucsNode.node?.node_id
if (ucsNodeId) {
  const ucsDelete = await call('manage_blueprint', 'delete_node', {
    blueprint_name: plainBlueprint,
    graph_name: 'UserConstructionScript',
    node_id: ucsNodeId,
  })
  check('delete_node scopes to the same graph', ucsDelete.success !== false, ucsDelete)
} else {
  skip('delete_node scopes to the same graph', 'add_node returned no node id')
}

// cleanup
await call('manage_actor', 'delete', { name: 'UEV_ApiConsistencyProbe' })

console.log('')
console.log('='.repeat(60))
console.log('api-consistency: ' + passed + ' passed, ' + skipped + ' skipped, ' + failed + ' failed')
if (failed) {
  console.log('')
console.log('failures:')
  for (const failure of failures) console.log(' - ' + failure)
}
process.exitCode = failed ? 1 : 0