#!/usr/bin/env node
/**
 * Generate the tool reference (TOOLS.md) from a live control API catalog.
 *
 *   node tests/make-tool-reference.mjs --out <path> [--title "UEV 1.7.0"]
 *   node tests/make-tool-reference.mjs --descriptor <control.json> --out ...
 *
 * The catalog is the source of truth: parameter tables, descriptions and the
 * handle grammar documented on manage_query/manage_object come from
 * /api/catalog, so this file cannot drift from the shipped server.
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const hit = args.indexOf(name)
  return hit >= 0 && hit + 1 < args.length ? args[hit + 1] : fallback
}
const localAppData = process.env.LOCALAPPDATA ?? ''
const candidates = [
  option('--descriptor', ''),
  process.env.UEV_CONTROL_DESCRIPTOR,
  localAppData ? path.join(localAppData, 'UEV', 'control.json') : '',
].filter(Boolean)
let endpoint = { port: Number(option('--port', '0')), token: option('--token', '') }
// An explicit --port must not discard the descriptor's token: merge whatever the
// descriptor can add (port, token, descriptorPath) instead of taking the first hit.
for (const candidate of candidates) {
  if (endpoint.port && endpoint.token) break
  try {
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
    endpoint = {
      ...parsed,
      port: endpoint.port || parsed.port,
      token: endpoint.token || parsed.token,
      descriptorPath: candidate,
    }
  } catch {
    /* try the next candidate */
  }
}
if (!endpoint.port) throw new Error('No control descriptor found (tried ' + candidates.join(', ') + ')')

async function get(route) {
  const response = await fetch('http://127.0.0.1:' + endpoint.port + route, {
    headers: { Authorization: 'Bearer ' + endpoint.token },
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) throw new Error(route + ' failed: HTTP ' + response.status)
  return response.json()
}

const BT = String.fromCharCode(96)
const health = await get('/api/health')
const catalog = await get('/api/catalog')
const product = health.productName ?? 'UEV'
const title = option('--title', product + ' ' + (health.productVersion ?? ''))
const tools = catalog.tools ?? []
const direct = tools.filter((t) => t.kind === 'direct')
const namespaces = tools.filter((t) => t.kind !== 'direct').sort((a, b) => a.name.localeCompare(b.name))
let actions = 0
for (const t of tools) actions += (t.actions ?? []).length

const out = option('--out', path.join(process.cwd(), 'TOOLS.md'))
const lines = []
lines.push('# Tool reference - ' + title, '')
lines.push(
  'Generated from the live /api/catalog of package ' +
    (health.productVersion ?? '') +
    ', server ' +
    (health.serverVersion ?? '') +
    ', protocol ' +
    (health.protocolVersion ?? '') +
    '.',
)
lines.push('')
lines.push(
  '**' +
    tools.length +
    ' tools** (' +
    direct.length +
    ' direct + ' +
    namespaces.length +
    ' namespaces), **' +
    actions +
    ' actions**. Hidden compatibility aliases are not listed.',
)
lines.push('')
lines.push(
  'Every action uses the call shape POST /api/call {tool, action, params} or the equivalent MCP tool call. Parameters marked required must be present; alternatives appear as a | b.',
)
lines.push('')

function esc(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
function schemaProperties(schema) {
  const raw = schema?.properties
  if (Array.isArray(raw)) return raw.filter(Boolean)
  return raw && typeof raw === 'object' ? Object.values(raw).filter(Boolean) : []
}
function describe(schema) {
  if (!schema) return 'any'
  const bits = [schema.type ?? 'any']
  const props = schemaProperties(schema)
  if (props.length) bits.push('{' + props.map((x) => x.name).join(', ') + '}')
  if (schema.additionalProperties) bits.push('record<' + describe(schema.additionalProperties) + '>')
  return bits.join(' ')
}
function paramRows(params, depth) {
  const list = Array.isArray(params) ? params : Object.values(params ?? {}).filter(Boolean)
  const rows = []
  for (const p of list) {
    const pad = '  '.repeat(depth)
    const props = schemaProperties(p)
    const notes = []
    if (p.description) notes.push(String(p.description).replace(/\s+/g, ' '))
    if (p.enum && p.enum.length) notes.push('values: ' + p.enum.join(', '))
    if (p.variants && p.variants.length > 1) notes.push('one of: ' + p.variants.join(', '))
    if (props.length) notes.push('object: ' + props.map((x) => x.name).join(', '))
    if (p.additionalProperties) notes.push('record<' + describe(p.additionalProperties) + '>')
    if (p.discriminator) notes.push('variant key: ' + p.discriminator)
    if (p.items) notes.push((props.length ? 'or array of ' : 'array of ') + describe(p.items))
    rows.push('| ' + pad + BT + esc(p.name) + BT + ' | ' + esc(p.type ?? 'any') + ' | ' + (p.required ? 'yes' : 'no') + ' | ' + esc(notes.join('; ')) + ' |')
    if (props.length) rows.push(...paramRows(props, depth + 1))
    else if (p.items) {
      const itemProps = schemaProperties(p.items)
      if (itemProps.length) rows.push(...paramRows(itemProps.map((x) => ({ ...x, name: '[]' + '.' + x.name })), depth + 1))
    }
  }
  return rows
}

for (const group of [{ title: 'Direct tools', list: direct }, { title: 'Namespace tools', list: namespaces }]) {
  lines.push('## ' + group.title, '')
  for (const t of group.list) {
    lines.push('### ' + BT + t.name + BT, '')
    if (t.description) lines.push(t.description, '')
    const acts = (t.actions ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
    if (!acts.length) {
      lines.push('No named actions.', '')
      continue
    }
    for (const a of acts) {
      lines.push('#### ' + BT + t.name + '.' + a.name + BT, '')
      if (a.description) lines.push(a.description, '')
      const params = a.params ?? []
      if (params.length) {
        lines.push('| Parameter | Type | Required | Notes |', '|---|---|---|---|')
        for (const row of paramRows(params, 0)) lines.push(row)
        lines.push('')
      } else {
        lines.push('No parameters.', '')
      }
    }
  }
}

fs.mkdirSync(path.dirname(out), { recursive: true })
const body = lines.join('\n') + '\n'
fs.writeFileSync(out, body)
console.log(JSON.stringify({ out, tools: tools.length, actions, bytes: body.length }))