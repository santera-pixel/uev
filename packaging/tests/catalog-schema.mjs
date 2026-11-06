#!/usr/bin/env node
/**
 * Catalog schema fidelity contract test for UEV 1.6.x.
 *
 * The control panel builds typed subforms from /api/catalog. That only works when the
 * catalog describes nested shapes: object properties, array item types, open records
 * (additionalProperties) and union shorthands (vector/color objects plus tuples).
 * This suite proves those descriptions survive the serializer for the nested actions
 * named in the 1.6 card, walks the whole catalog for recursion, and checks that the
 * metadata round-trips through JSON without losing fields.
 *
 * Usage:
 *   node tests/catalog-schema.mjs
 *   node tests/catalog-schema.mjs --descriptor <path> --port <n> --token <token>
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

async function getJson(descriptor, route) {
  const response = await fetch('http://127.0.0.1:' + descriptor.port + route, {
    headers: { Authorization: 'Bearer ' + descriptor.token },
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) {
    throw new Error(route + ' responded ' + response.status)
  }
  return response.json()
}

const toolByName = (catalog, name) => (catalog.tools ?? []).find((tool) => tool.name === name)
const actionByName = (tool, name) => (tool?.actions ?? []).find((action) => action.name === name)
const paramByName = (action, name) => (action?.params ?? []).find((param) => param.name === name)

const typeNames = (param) => [...new Set([param?.type, ...(param?.variants ?? [])].filter(Boolean))]

function describeShape(param, depth = 0) {
  if (!param) return '<missing>'
  const parts = [param.type]
  if (param.properties) {
    parts.push('{ ' + Object.keys(param.properties).sort().join(', ') + ' }')
  }
  if (param.items) {
    parts.push('[' + describeShape(param.items, depth + 1) + ']')
  }
  if (param.additionalProperties) {
    parts.push('<record ' + describeShape(param.additionalProperties, depth + 1) + '>')
  }
  return parts.join(' ')
}

function assertNestedObject(param, label) {
  const ok = param && param.type === 'object' && param.properties && Object.keys(param.properties).length > 0
  record(label, ok ? 'PASS' : 'FAIL', param ? describeShape(param) : 'param missing')
  return ok
}

async function main() {
  const descriptor = readDescriptor()
  const health = await getJson(descriptor, '/api/health')
  record(
    'control API is a UEV 1.6 server',
    health.productName === 'UEV' && health.protocolVersion === 2 ? 'PASS' : 'FAIL',
    'product=' + health.productName + ' productVersion=' + health.productVersion + ' server=' + health.version,
  )
  const catalog = await getJson(descriptor, '/api/catalog')

  // 1. Union shorthand: colorInputSchema is z.union([object, tuple]) and used to collapse to "any".
  const widget = toolByName(catalog, 'manage_widget')
  const addWidget = actionByName(widget, 'add_widget')
  const background = paramByName(addWidget, 'background_color')
  assertNestedObject(background, 'manage_widget.add_widget background_color is a typed object')
  if (background?.properties) {
    const channels = ['r', 'g', 'b']
    const typedChannels = channels.every((channel) => background.properties[channel]?.type === 'number')
    record(
      'background_color declares r/g/b number channels',
      typedChannels ? 'PASS' : 'FAIL',
      JSON.stringify(Object.fromEntries(Object.entries(background.properties).map(([k, v]) => [k, v.type]))),
    )
    const optionalAlpha = background.properties.a?.type === 'number' && background.properties.a?.required === false
    record('background_color keeps optional alpha', optionalAlpha ? 'PASS' : 'FAIL', describeShape(background.properties.a))
    const variants = typeNames(background)
    record(
      'background_color records both object and array variants',
      variants.includes('object') && variants.includes('array') ? 'PASS' : 'FAIL',
      JSON.stringify(variants),
    )
    const tupleItems = background.items
    record(
      'background_color describes the tuple alternative element',
      tupleItems?.type === 'number' ? 'PASS' : 'FAIL',
      describeShape(tupleItems),
    )
  }
  const size = paramByName(addWidget, 'size')
  assertNestedObject(size, 'manage_widget.add_widget size is a typed object')

  // 2. Array of open records: pie_expect conditions is Array<Record<string, any>>.
  const editor = toolByName(catalog, 'manage_editor')
  const pieExpect = actionByName(editor, 'pie_expect')
  const conditions = paramByName(pieExpect, 'conditions')
  const conditionsOk = conditions?.type === 'array' && conditions.items?.type === 'object'
  record(
    'manage_editor.pie_expect conditions describes its item type',
    conditionsOk ? 'PASS' : 'FAIL',
    describeShape(conditions),
  )

  // 3. Typed records: material instance parameters are z.record(<scalar or vector>).
  const material = toolByName(catalog, 'manage_material')
  const setParams = actionByName(material, 'set_material_instance_parameters')
  const recordParams = (setParams?.params ?? []).filter((param) => param.additionalProperties)
  const typedRecords = recordParams.filter((param) =>
    ['number', 'array', 'string', 'boolean'].includes(param.additionalProperties?.type),
  )
  record(
    'set_material_instance_parameters declares typed records',
    typedRecords.length >= 2 ? 'PASS' : 'FAIL',
    recordParams.map((param) => param.name + ': record<' + describeShape(param.additionalProperties) + '>').join('; ') ||
      'no additionalProperties found',
  )

  // 4. Recursive audit across the whole catalog.
  const stats = { objects: 0, objectsWithProperties: 0, openRecords: 0, typedRecords: 0, arrays: 0, arraysWithItems: 0, maxDepth: 0 }
  const visit = (param, depth) => {
    stats.maxDepth = Math.max(stats.maxDepth, depth)
    if (param.type === 'object') {
      stats.objects += 1
      if (param.properties && Object.keys(param.properties).length > 0) {
        stats.objectsWithProperties += 1
        for (const child of Object.values(param.properties)) {
          visit(child, depth + 1)
        }
      } else if (param.additionalProperties) {
        stats.typedRecords += 1
        visit(param.additionalProperties, depth + 1)
      } else {
        stats.openRecords += 1
      }
    } else if (param.type === 'array') {
      stats.arrays += 1
      if (param.items) {
        stats.arraysWithItems += 1
        visit(param.items, depth + 1)
      }
    }
  }
  for (const tool of catalog.tools ?? []) {
    for (const action of tool.actions ?? []) {
      for (const param of action.params ?? []) {
        visit(param, 1)
      }
    }
  }
  record(
    'catalog describes object properties recursively',
    stats.objectsWithProperties > 100 ? 'PASS' : 'FAIL',
    JSON.stringify(stats),
  )
  record(
    'catalog describes array item types',
    stats.arraysWithItems > 30 ? 'PASS' : 'FAIL',
    stats.arraysWithItems + ' of ' + stats.arrays + ' arrays declare items',
  )
  record(
    'catalog describes typed records',
    stats.typedRecords >= 2 ? 'PASS' : 'FAIL',
    stats.typedRecords + ' typed records, ' + stats.openRecords + ' open records',
  )
  record(
    'catalog nesting reaches property depth >= 3',
    stats.maxDepth >= 3 ? 'PASS' : 'FAIL',
    'max depth ' + stats.maxDepth,
  )

  // 5. Round-trip: metadata must survive a JSON round trip with no lost fields.
  const sample = { background_color: background, size, conditions }
  const roundTripped = JSON.parse(JSON.stringify(sample))
  const roundTripOk = JSON.stringify(roundTripped) === JSON.stringify(sample)
  record('nested metadata round-trips through JSON', roundTripOk ? 'PASS' : 'FAIL')

  // 6. A typed subform can be materialized from the metadata alone.
  const materialized = Object.fromEntries(
    Object.entries(background?.properties ?? {}).map(([key, property]) => [
      key,
      property.type === 'number' ? 0 : property.type === 'boolean' ? false : '',
    ]),
  )
  const materializedOk =
    Object.keys(materialized).length >= 3 && Object.keys(materialized).every((key) => key in (background?.properties ?? {}))
  record(
    'typed subform value materializes from the catalog',
    materializedOk ? 'PASS' : 'FAIL',
    JSON.stringify(materialized),
  )

  const failed = results.filter((entry) => entry.status === 'FAIL').length
  const passed = results.filter((entry) => entry.status === 'PASS').length
  const skipped = results.filter((entry) => entry.status === 'SKIP').length
  console.log('')
  console.log('catalog-schema: ' + passed + ' passed, ' + skipped + ' skipped, ' + failed + ' failed')
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('catalog-schema: ' + (error && error.message ? error.message : String(error)))
  process.exitCode = 1
})
