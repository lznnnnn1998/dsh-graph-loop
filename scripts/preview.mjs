#!/usr/bin/env node
// Build an offline preview panel for graph-loop turns.
//
// Reads the per-turn trace JSON written by GraphRuntime.recordTurn
// (config `traceDir`, default /tmp/dsh-graph-traces) and writes
// preview/index.html: one tab per turn, an SVG topology, and a node inspector
// with the information flow (instruction → status → step).
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? '/tmp/dsh-graph-traces')
const outDir = resolve(process.argv[3] ?? 'preview')
const outFile = join(outDir, 'index.html')

if (!existsSync(dir)) {
  console.error(`no trace directory: ${dir}\nrun an e2e/agent turn with graph-runtime.traceDir set to this path`)
  process.exit(1)
}
const turns = readdirSync(dir)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => {
    try { return JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { return undefined }
  })
  .filter(Boolean)
  // Root agents first, then children by delegation depth; stable within a depth.
  .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || String(a.at ?? '').localeCompare(String(b.at ?? '')))

if (turns.length === 0) {
  console.error(`no trace files in ${dir}`)
  process.exit(1)
}

/** BFS depth from the entry so branches share a column. */
function depths(plan) {
  const nodes = plan?.nodes ?? []
  const edges = plan?.edges ?? []
  const byId = new Map(nodes.map(node => [node.id, node]))
  const depth = new Map()
  const queue = [[plan?.entry, 0]]
  while (queue.length > 0) {
    const [id, d] = queue.shift()
    if (typeof id !== 'string' || !byId.has(id)) continue
    if (depth.has(id) && depth.get(id) <= d) continue
    depth.set(id, d)
    for (const edge of edges) if (edge.from === id) queue.push([edge.to, d + 1])
  }
  let fallback = 0
  for (const node of nodes) if (!depth.has(node.id)) depth.set(node.id, fallback++)
  return depth
}

function renderTurn(turn, index) {
  const plan = turn.plan ?? { nodes: [], edges: [], entry: undefined }
  const trail = turn.trail ?? []
  const byId = new Map((plan.nodes ?? []).map(node => [node.id, node]))
  const depth = depths(plan)
  const columns = new Map()
  const ordered = [...(plan.nodes ?? [])].sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.id.localeCompare(b.id))
  for (const node of ordered) {
    const d = depth.get(node.id) ?? 0
    if (!columns.has(d)) columns.set(d, [])
    columns.get(d).push(node)
  }
  const W = 240, H = 108, PAD = 40
  const maxRows = Math.max(...[...columns.values()].map(list => list.length), 1)
  const width = PAD * 2 + columns.size * W
  const height = PAD * 2 + maxRows * H
  const pos = new Map()
  for (const [d, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    list.forEach((node, row) => pos.set(node.id, { x: PAD + d * W + 20, y: PAD + row * H + 20 }))
  }
  const trailById = new Map(trail.map(item => [item.id, item]))
  const drawn = (plan.nodes ?? []).filter(node => trailById.has(node.id)).length
  const edgesSvg = (plan.edges ?? []).map(edge => {
    const a = pos.get(edge.from), b = pos.get(edge.to)
    if (!a || !b) return ''
    const x1 = a.x + 200, y1 = a.y + 34, x2 = b.x, y2 = b.y + 34
    const mid = (x1 + x2) / 2
    return `<path d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" class="edge" marker-end="url(#arrow)"/>`
  }).join('')
  const nodesSvg = (plan.nodes ?? []).map(node => {
    const p = pos.get(node.id) ?? { x: 0, y: 0 }
    const t = trailById.get(node.id)
    const status = t === undefined ? 'pending' : t.status
    return `<g class="node ${status}" data-node="${esc(node.id)}" transform="translate(${p.x},${p.y})">
      <rect width="200" height="68" rx="10"></rect>
      <text class="id" x="12" y="22">${esc(node.id)}</text>
      <text class="meta" x="12" y="42">${esc(node.executor ?? 'step')}${t ? ` · step ${t.step}` : ''}</text>
      <text class="status" x="12" y="60">${status}</text>
    </g>`
  }).join('')
  const inspector = (plan.nodes ?? []).map(node => {
    const t = trailById.get(node.id)
    return `<article class="inspector" id="inspect-${esc(node.id)}" hidden>
      <h3>${esc(node.id)}</h3>
      <p class="kv"><span>kind</span>${esc(node.kind ?? '')}</p>
      <p class="kv"><span>executor</span>${esc(node.executor ?? 'step')}</p>
      <p class="kv"><span>status</span>${t ? esc(t.status) + ` (step ${t.step})` : 'not executed'}</p>
      <p class="instruction">${esc(node.instruction ?? '(no instruction)')}</p>
    </article>`
  }).join('')
  return { index, html: `
  <section class="turn" data-turn="${index}" ${index === 0 ? '' : 'hidden'}>
    <header>
      <div>
        <h2>Turn ${index + 1} · ${esc(turn.mode ?? 'unknown')} / ${esc(turn.templateId ?? '')} ${(turn.depth ?? 0) > 0 ? `· child depth ${turn.depth}` : '· root'}</h2>
        <p class="sub">${esc(turn.sessionId ?? '')} · plan ${esc(turn.planId ?? '')} · ${drawn}/${(plan.nodes ?? []).length} nodes executed</p>
      </div>
      <div class="stats"><b>${trail.length}</b> nodes · <b>${(plan.edges ?? []).length}</b> edges · ${esc(turn.at ?? '')}</div>
    </header>
    <div class="body">
      <div class="canvas"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
        <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#4b5563"/></marker></defs>
        ${edgesSvg}${nodesSvg}
      </svg></div>
      <aside class="side">
        <h3>Information flow</h3>
        <ol class="flow">${trail.map(item => `<li><b>${esc(item.id)}</b><span>step ${item.step} · ${esc(item.executor)} · ${esc(item.status)}</span></li>`).join('') || '<li class="muted">no nodes executed</li>'}</ol>
        <h3>Rationale</h3>
        <ul class="rationale">${(turn.rationale ?? []).map(line => `<li>${esc(line)}</li>`).join('') || '<li class="muted">-</li>'}</ul>
        ${inspector}
      </aside>
    </div>
  </section>` }
}

const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
const sections = turns.map(renderTurn)
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>DSH graph loop · topology preview</title>
<style>
:root { color-scheme: dark; --bg:#0b0f14; --panel:#111821; --line:#1f2a37; --text:#e5e7eb; --muted:#9ca3af; --ok:#22c55e; --fail:#ef4444; --pending:#374151; --accent:#38bdf8; }
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
header.top{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
h1{font-size:16px;margin:0} .muted{color:var(--muted)} .tabs{display:flex;gap:8px;flex-wrap:wrap;padding:12px 20px}
.tabs button{background:#0f1720;color:var(--text);border:1px solid var(--line);padding:6px 10px;border-radius:8px;cursor:pointer}
.tabs button.active{border-color:var(--accent);color:var(--accent)}
.turn{padding:0 20px 24px} .turn header{display:flex;justify-content:space-between;align-items:flex-start;padding:14px 0}
h2{font-size:15px;margin:0} h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 0 8px}
.sub{margin:4px 0 0;color:var(--muted);font-size:12px} .stats{color:var(--muted);font-size:12px}
.body{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px}
.canvas{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:auto;padding:8px}
svg{display:block} .edge{fill:none;stroke:#4b5563;stroke-width:1.5}
.node rect{fill:#0f1720;stroke:var(--pending);stroke-width:2}
.node.ok rect{stroke:var(--ok)} .node.failed rect{stroke:var(--fail)}
.node .id{fill:var(--text);font-size:12px;font-weight:600} .node .meta{fill:var(--muted);font-size:11px}
.node .status{fill:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
.node.ok .status{fill:var(--ok)} .node.failed .status{fill:var(--fail)}
.node{cursor:pointer}
.side{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;max-height:70vh;overflow:auto}
.flow,.rationale{margin:0;padding-left:18px} .flow li,.rationale li{margin:6px 0;font-size:12px}
.flow span{display:block;color:var(--muted);font-size:11px}
.inspector{border-top:1px solid var(--line);margin-top:14px;padding-top:10px}
.inspector h3{margin:0 0 8px;color:var(--text);text-transform:none;font-size:13px}
.kv{display:flex;gap:8px;margin:4px 0;font-size:12px}.kv span{color:var(--muted);min-width:64px}
.instruction{font-size:12px;color:#d1d5db;background:#0b1219;border:1px solid var(--line);border-radius:8px;padding:8px;margin-top:8px}
@media (max-width:900px){.body{grid-template-columns:1fr}.side{max-height:none}}
</style></head><body>
<header class="top"><h1>DSH graph loop · topology preview</h1><span class="muted">${turns.length} turn(s) · ${esc(dir)}</span></header>
<div class="tabs">${sections.map(s => `<button data-tab="${s.index}" class="${s.index === 0 ? 'active' : ''}">Turn ${s.index + 1}</button>`).join('')}</div>
<main>${sections.map(s => s.html).join('')}</main>
<script>
const buttons=[...document.querySelectorAll('.tabs button')];
buttons.forEach(button=>button.addEventListener('click',()=>{
  buttons.forEach(b=>b.classList.toggle('active',b===button));
  document.querySelectorAll('.turn').forEach(section=>{section.hidden=section.dataset.turn!==button.dataset.tab});
}));
document.querySelectorAll('.node').forEach(node=>node.addEventListener('click',()=>{
  const turn=node.closest('.turn');
  turn.querySelectorAll('.inspector').forEach(panel=>{panel.hidden=true});
  const panel=turn.querySelector('#inspect-'+CSS.escape(node.dataset.node));
  if(panel) panel.hidden=false;
}));
</script></body></html>`

mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, html)
console.log(`wrote ${outFile} (${turns.length} turn(s) from ${dir})`)
