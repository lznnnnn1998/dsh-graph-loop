/**
 * Graph tab for the DSH Web conversation view.
 *
 * Hand-written closure-factory bundle (same envelope as the tsdown client
 * preset): registers a `conversation.view` entry next to Chat/Trajectory and
 * polls the host graph-chat API for the current session's per-turn topology.
 * React, hooks and the slot service come from the browser module table.
 */
window.__ModuleLoader__.load({
  id: '@dsh/explore-graph-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    Object.defineProperty(exports, '__esModule', { value: true })
    var React = require('react')
    var h = React.createElement

    var STYLE_ID = 'dsh-graph-view-style'
    var CSS = [
      '.dshgv{height:100%;display:flex;flex-direction:column;min-height:0;background:var(--color-bg-primary,#070b10);color:var(--color-text-primary,#e6e9ef);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
      '.dshgv-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--color-border-primary,#1c2632);flex-wrap:wrap}',
      '.dshgv-head h3{font-size:12px;margin:0;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-secondary,#8b97a6)}',
      '.dshgv-pill{border:1px solid #1c2632;border-radius:999px;padding:3px 9px;font-size:11px;color:#8b97a6;background:#0a1118;cursor:pointer;white-space:nowrap}',
      '.dshgv-pill.on{color:#38bdf8;border-color:#38bdf8}',
      '.dshgv-canvas{flex:1;overflow:auto;padding:10px;min-height:0}',
      '.dshgv-side{border-top:1px solid #1c2632;max-height:30%;overflow:auto;padding:10px 16px}',
      '.dshgv-side h4{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8b97a6;margin:0 0 6px}',
      '.dshgv-flow{list-style:none;margin:0 0 10px;padding:0;display:flex;flex-direction:column;gap:4px}',
      '.dshgv-flow li{display:flex;gap:8px;font-size:11px;align-items:baseline}.dshgv-flow b{color:#e6e9ef}.dshgv-flow span{color:#8b97a6}',
      '.dshgv-empty{padding:40px 20px;text-align:center;color:#8b97a6}',
      '.dshgv svg{display:block}.dshgv .edge{fill:none;stroke:#3b4a5c;stroke-width:1.5}',
      '.dshgv .node rect{fill:#0b1118;stroke:#475569;stroke-width:2}',
      '.dshgv .node.ok rect{stroke:#22c55e}.dshgv .node.failed rect{stroke:#ef4444}.dshgv .node.pending rect{stroke:#475569;stroke-dasharray:4 3}',
      '.dshgv .node .id{fill:#e6e9ef;font-size:12px;font-weight:600}.dshgv .node .meta{fill:#8b97a6;font-size:10px}.dshgv .node .status{fill:#8b97a6;font-size:9px;text-transform:uppercase;letter-spacing:.08em}',
      '.dshgv .node.ok .status{fill:#22c55e}.dshgv .node.failed .status{fill:#ef4444}',
      '.dshgv .node{cursor:pointer}.dshgv .inspect{margin-top:8px;padding:8px;background:#0a1118;border:1px solid #1c2632;border-radius:8px;font-size:11px;white-space:pre-wrap}'
    ].join('')

    function injectStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      var tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function esc(value) { return String(value == null ? '' : value) }

    function depths(plan) {
      var nodes = (plan && plan.nodes) || []
      var edges = (plan && plan.edges) || []
      var ids = new Set(nodes.map(function (n) { return n.id }))
      var depth = new Map()
      var queue = [[plan && plan.entry, 0]]
      while (queue.length) {
        var pair = queue.shift()
        var id = pair[0], d = pair[1]
        if (typeof id !== 'string' || !ids.has(id)) continue
        if (depth.has(id) && depth.get(id) <= d) continue
        depth.set(id, d)
        edges.forEach(function (edge) { if (edge.from === id) queue.push([edge.to, d + 1]) })
      }
      var fallback = 0
      nodes.forEach(function (node) { if (!depth.has(node.id)) depth.set(node.id, fallback++) })
      return depth
    }

    function GraphBody(props) {
      var sessionId = props.sessionId
      var [turns, setTurns] = React.useState([])
      var [selected, setSelected] = React.useState(0)
      var [inspect, setInspect] = React.useState(null)
      var [error, setError] = React.useState(null)

      React.useEffect(function () {
        var alive = true
        async function load() {
          try {
            var response = await fetch('/graph-chat/api/state?sessionId=' + encodeURIComponent(sessionId))
            var body = await response.json()
            if (!alive) return
            setTurns(body.turns || [])
            setError(null)
          } catch (err) { if (alive) setError(String(err)) }
        }
        load()
        var timer = setInterval(load, 1200)
        return function () { alive = false; clearInterval(timer) }
      }, [sessionId])

      var turn = turns[turns.length - 1 - selected]
      if (!turn) {
        return h('div', { className: 'dshgv' },
          h('div', { className: 'dshgv-head' }, h('h3', null, 'Graph'), h('span', { className: 'dshgv-pill' }, sessionId || 'no session')),
          h('div', { className: 'dshgv-empty' }, error || 'No graph run yet. Send a message in Chat; the topology for each turn appears here.'))
      }
      var plan = turn.plan || { nodes: [], edges: [] }
      var trail = turn.trail || []
      var trailById = new Map(trail.map(function (item) { return [item.id, item] }))
      var depth = depths(plan)
      var columns = new Map()
      var ordered = (plan.nodes || []).slice().sort(function (a, b) {
        return (depth.get(a.id) || 0) - (depth.get(b.id) || 0) || String(a.id).localeCompare(String(b.id))
      })
      ordered.forEach(function (node) {
        var d = depth.get(node.id) || 0
        if (!columns.has(d)) columns.set(d, [])
        columns.get(d).push(node)
      })
      var W = 220, H = 94, PAD = 24
      var maxRows = 1
      columns.forEach(function (list) { if (list.length > maxRows) maxRows = list.length })
      var width = PAD * 2 + columns.size * W
      var height = PAD * 2 + maxRows * H
      var pos = new Map()
      Array.from(columns.entries()).sort(function (a, b) { return a[0] - b[0] }).forEach(function (entry) {
        entry[1].forEach(function (node, row) { pos.set(node.id, { x: PAD + entry[0] * W + 14, y: PAD + row * H + 14 }) })
      })
      var edges = (plan.edges || []).map(function (edge) {
        var a = pos.get(edge.from), b = pos.get(edge.to)
        if (!a || !b) return null
        var x1 = a.x + 190, y1 = a.y + 30, x2 = b.x, y2 = b.y + 30, mid = (x1 + x2) / 2
        return h('path', { key: edge.from + '>' + edge.to, className: 'edge', d: 'M ' + x1 + ' ' + y1 + ' C ' + mid + ' ' + y1 + ', ' + mid + ' ' + y2 + ', ' + x2 + ' ' + y2, markerEnd: 'url(#dshgv-arrow)' })
      })
      var nodes = (plan.nodes || []).map(function (node) {
        var p = pos.get(node.id) || { x: 0, y: 0 }
        var t = trailById.get(node.id)
        var status = t ? t.status : 'pending'
        return h('g', {
          key: node.id, className: 'node ' + status, transform: 'translate(' + p.x + ',' + p.y + ')',
          onClick: function () { setInspect(node) }
        },
          h('rect', { width: 190, height: 60, rx: 9 }),
          h('text', { className: 'id', x: 11, y: 21 }, node.id),
          h('text', { className: 'meta', x: 11, y: 39 }, (node.executor || 'step') + (t ? ' · step ' + t.step : '')),
          h('text', { className: 'status', x: 11, y: 55 }, status))
      })
      var pills = turns.map(function (item, index) {
        var back = turns.length - 1 - index
        return h('button', {
          key: back, className: 'dshgv-pill' + (back === selected ? ' on' : ''),
          onClick: function () { setSelected(back); setInspect(null) }
        }, 'Turn ' + (back + 1))
      }).reverse()
      return h('div', { className: 'dshgv' },
        h('div', { className: 'dshgv-head' },
          h('h3', null, 'Graph'), pills,
          h('span', { className: 'dshgv-pill' }, (turn.mode || '') + ' · ' + (turn.replans ? turn.replans + ' replan' : 'no replan'))),
        h('div', { className: 'dshgv-canvas' },
          h('svg', { viewBox: '0 0 ' + width + ' ' + height, width: width, height: height },
            h('defs', null, h('marker', { id: 'dshgv-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
              h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#3b4a5c' }))),
            edges, nodes)),
        h('div', { className: 'dshgv-side' },
          h('h4', null, 'Information flow'),
          h('ul', { className: 'dshgv-flow' }, trail.map(function (item) {
            return h('li', { key: item.id }, h('b', null, item.id), h('span', null, 'step ' + item.step + ' · ' + item.executor + ' · ' + item.status))
          })),
          h('h4', null, 'Rationale'),
          h('ul', { className: 'dshgv-flow' }, (turn.rationale || []).map(function (line, index) { return h('li', { key: index }, h('span', null, line)) })),
          inspect ? h('div', { className: 'inspect' }, h('b', null, inspect.id), '\n', esc(inspect.instruction || '(no instruction)')) : null))
    }

    function apply(ctx) {
      injectStyle()
      ctx.effect(function () {
        return ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register({
            name: 'conversation.view',
            id: 'graph',
            order: 5,
            label: 'Graph'
          }, GraphBody)
        })
      }, 'graph-view:tab')
    }

    exports.name = 'explore-graph-view'
    exports.inject = ['slots']
    exports.apply = apply
    exports.GraphBody = GraphBody
    return module.exports
  }
})
