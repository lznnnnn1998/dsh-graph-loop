/**
 * Graph tab for the DSH Web conversation view.
 *
 * Hand-written closure-factory bundle (same envelope as the tsdown client
 * preset): registers a `conversation.view` entry next to Chat/Trajectory and
 * polls the host graph-chat API for the current session's per-turn topology.
 * React, hooks and the slot service come from the browser module table.
 *
 * Two levels, Obsidian-graph style:
 *   1. Overview - one dot per turn in a deterministic force-directed net.
 *      The simulation only reruns when the turn set/shape changes, tracked by
 *      a signature of node ids, plan sizes and edge pairs; a poll that only
 *      refreshes statuses/trail re-renders without relayout.
 *   2. Drill-in - the selected turn's plan as a depth-layered node-link
 *      diagram, with back/same-column edges detoured below the node block.
 */
window.__ModuleLoader__.load({
  id: 'dsh-graph-loop-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    Object.defineProperty(exports, '__esModule', { value: true })
    var React = require('react')
    var h = React.createElement
    var NS = 'graph'
    var EN = {
      view: 'Graph',
      empty: 'No graph run yet. Send a message in Chat; the topology for each turn appears here.',
      flow: 'Information flow',
      rationale: 'Rationale',
      tools: 'Tool calls',
      openTrajectory: 'open in trajectory',
      turn: 'Turn',
      live: 'LIVE',
      step: 'step',
      steps: 'steps',
      noSession: 'no session',
      replan: 'replan',
      noReplan: 'no replan',
      allTurns: 'All turns',
      back: 'Back',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      fit: 'Fit',
      legend: 'Legend',
      ok: 'ok',
      failed: 'failed',
      pending: 'pending',
      selected: 'selected',
      nodes: 'Nodes',
      inspect: 'Inspect',
      selectNode: 'Select a node to inspect its instruction, step and tool calls.',
      noInstruction: '(no instruction)',
      noNodes: 'no nodes executed',
      noPlan: 'No plan recorded for this turn.',
      overviewAria: 'Turn overview. Arrow keys move between turns; Enter opens a turn.',
      viewControls: 'Graph view controls',
      detailAria: 'Turn detail',
      executor: 'Executor',
      status: 'Status',
      kind: 'Kind'
    }
    var ZH = {
      view: '图',
      empty: '还没有图运行。在 Chat 里发送消息，这一轮生成的拓扑会显示在这里。',
      flow: '信息流',
      rationale: '决策依据',
      tools: '工具调用',
      openTrajectory: '在 Trajectory 中打开',
      turn: '轮次',
      live: '实时',
      step: '步',
      steps: '步',
      noSession: '无会话',
      replan: '次重规划',
      noReplan: '无重规划',
      allTurns: '全部轮次',
      back: '返回',
      zoomIn: '放大',
      zoomOut: '缩小',
      fit: '适应',
      legend: '图例',
      ok: '成功',
      failed: '失败',
      pending: '等待',
      selected: '选中',
      nodes: '节点',
      inspect: '检查',
      selectNode: '选择一个节点，查看它的指令、步骤和工具调用。',
      noInstruction: '（无指令）',
      noNodes: '没有执行节点',
      noPlan: '这一轮没有记录计划。',
      overviewAria: '轮次总览。方向键切换轮次，回车打开该轮次。',
      viewControls: '图视图控制',
      detailAria: '轮次详情',
      executor: '执行者',
      status: '状态',
      kind: '类型'
    }

    // Design tokens (dark OLED, density 8): mirrored in CSS below so SVG
    // attributes and CSS-only chrome agree.
    var C = {
      bg: '#0F172A',
      surface: '#1B2336',
      surface2: '#272F42',
      border: '#475569',
      fg: '#F8FAFC',
      muted: '#94A3B8',
      muted2: '#64748B',
      ok: '#22C55E',
      failed: '#EF4444',
      failedText: '#F87171',
      amber: '#F59E0B',
      focus: '#60A5FA',
      edge: '#90A4AE'
    }

    var STYLE_ID = 'dsh-graph-view-style'
    var CSS = [
      /* ---- shell ---- */
      '.dshgv{--gv-bg:#0F172A;--gv-surface:#1B2336;--gv-surface-2:#272F42;--gv-border:#475569;--gv-fg:#F8FAFC;--gv-muted:#94A3B8;--gv-ok:#22C55E;--gv-failed:#EF4444;--gv-failed-text:#F87171;--gv-amber:#F59E0B;--gv-focus:#60A5FA;--gv-edge:#90A4AE;--gv-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--gv-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--gv-bg);color:var(--gv-fg);font:13px/1.5 var(--gv-sans)}',
      '.dshgv *{box-sizing:border-box}',
      '.dshgv-view{display:flex;flex-direction:column;flex:1;min-height:0}',
      '.dshgv button{font:inherit;color:inherit}',
      '.dshgv button:focus-visible,.dshgv [role="button"]:focus-visible{outline:2px solid var(--gv-focus);outline-offset:2px}',
      '.dshgv .dshgv-ov-node:focus,.dshgv .dshgv-ov-node:focus-visible,.dshgv .dshgv-node:focus,.dshgv .dshgv-node:focus-visible{outline:none}',
      '.dshgv-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
      /* ---- toolbar ---- */
      '.dshgv-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 14px;min-height:44px;border-bottom:1px solid rgba(71,85,105,.45);background:var(--gv-bg);flex:0 0 auto}',
      '.dshgv-title{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--gv-muted);white-space:nowrap}',
      '.dshgv-title b{color:var(--gv-fg);font-weight:600;font-variant-numeric:tabular-nums}',
      '.dshgv-live{display:inline-flex;align-items:center;gap:5px;font:10px/1 var(--gv-mono);letter-spacing:.08em;color:var(--gv-ok)}',
      '.dshgv-live i{width:6px;height:6px;border-radius:50%;background:var(--gv-ok);box-shadow:0 0 0 3px rgba(34,197,94,.14)}',
      '.dshgv-tools{display:flex;align-items:center;gap:6px;margin-left:auto}',
      '.dshgv-btn{height:28px;min-width:28px;padding:0 8px;display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(71,85,105,.7);border-radius:7px;background:var(--gv-surface);color:#CBD5E1;font-size:12px;cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease,color 160ms ease}',
      '.dshgv-btn:hover{background:var(--gv-surface-2);border-color:#64748B;color:var(--gv-fg)}',
      '.dshgv-btn:active{background:#334155}',
      '.dshgv-zoom{min-width:42px;text-align:center;font:11px/1 var(--gv-mono);color:var(--gv-muted);font-variant-numeric:tabular-nums}',
      '.dshgv-back{padding:0 10px;font-size:15px}',
      '.dshgv-crumb{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--gv-muted);min-width:0}',
      '.dshgv-crumb b{color:var(--gv-fg);font-weight:600;white-space:nowrap}',
      '.dshgv-crumb-link{background:none;border:0;padding:2px 3px;margin:0;border-radius:5px;color:var(--gv-muted);cursor:pointer;font-size:12px;transition:color 160ms ease,background-color 160ms ease}',
      '.dshgv-crumb-link:hover{color:var(--gv-fg);background:var(--gv-surface-2)}',
      '.dshgv-crumb-sep{color:var(--gv-muted)}',
      '.dshgv-meta{margin-left:auto;display:flex;align-items:center;gap:8px;font:11px/1.4 var(--gv-mono);color:var(--gv-muted);white-space:nowrap;flex-wrap:wrap;justify-content:flex-end}',
      '.dshgv-meta .dshgv-st{margin-left:0}',
      '.dshgv-session{margin-left:auto;font:10px/1 var(--gv-mono);color:var(--gv-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}',
      '.dshgv-legend{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--gv-muted);white-space:nowrap}',
      '.dshgv-legend span{display:inline-flex;align-items:center;gap:5px}',
      '.dshgv-legend i{width:8px;height:8px;border-radius:50%;display:inline-block;border:1px solid rgba(15,23,42,.65)}',
      /* ---- overview canvas ---- */
      '.dshgv-stage{position:relative;flex:1;min-height:0;overflow:hidden;background-color:var(--gv-bg);background-image:radial-gradient(1200px 700px at 50% 42%,rgba(30,41,59,.65),rgba(15,23,42,0) 70%),radial-gradient(circle at 1px 1px,rgba(148,163,184,.10) 1px,rgba(15,23,42,0) 0);background-size:auto,22px 22px;animation:dshgv-fade 180ms ease-out both}',
      '.dshgv-stage svg{display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none}',
      '.dshgv-bg{fill:transparent;cursor:grab}',
      '.dshgv-stage.dragging .dshgv-bg,.dshgv-stage.dragging .dshgv-ov-node{cursor:grabbing}',
      '.dshgv-ov-node{transition:opacity 160ms ease}',
      '.dshgv-ov-node{cursor:pointer}',
      '.dshgv-ov-hit{pointer-events:all}',
      '.dshgv-ov-dot{transition:stroke 160ms ease,opacity 160ms ease}',
      '.dshgv-ov-node:hover .dshgv-ov-dot,.dshgv-ov-node.active .dshgv-ov-dot{stroke:#E2E8F0!important;stroke-width:1.5}',
      '.dshgv-ov-ring{fill:none;stroke:var(--gv-focus);stroke-width:2;opacity:0;transition:opacity 160ms ease;pointer-events:none}',
      '.dshgv-ov-node:focus-visible .dshgv-ov-ring{opacity:1}',
      '.dshgv-ov-sel{fill:none;stroke:var(--gv-amber);stroke-width:2;opacity:0;transition:opacity 160ms ease;pointer-events:none}',
      '.dshgv-ov-node.selected .dshgv-ov-sel{opacity:.55}',
      '.dshgv-ov-label{font-family:var(--gv-sans);font-size:12px;font-weight:500;fill:#E2E8F0;text-anchor:middle;pointer-events:none;paint-order:stroke;stroke:rgba(15,23,42,.92);stroke-width:3px;stroke-linejoin:round;transition:opacity 160ms ease}',
      '.dshgv-ov-edge{pointer-events:none;transition:opacity 160ms ease}',
      /* ---- detail ---- */
      '.dshgv-detail{display:flex;flex:1;min-height:0;animation:dshgv-fade 180ms ease-out both}',
      '.dshgv-detail-canvas{flex:1;min-width:0;overflow:auto;padding:22px;background-color:var(--gv-bg);background-image:radial-gradient(circle at 1px 1px,rgba(148,163,184,.08) 1px,rgba(15,23,42,0) 0);background-size:22px 22px}',
      '.dshgv-detail-canvas svg{display:block;margin:0 auto}',
      '.dshgv-canvas-empty{height:100%;min-height:180px;display:flex;align-items:center;justify-content:center;color:var(--gv-muted);font-size:12px;text-align:center;padding:30px}',
      '.dshgv-node{cursor:pointer}',
      '.dshgv-node-box{fill:var(--gv-surface);stroke:var(--gv-border);stroke-width:1.5;transition:fill 160ms ease,stroke 160ms ease,stroke-width 160ms ease}',
      '.dshgv-node:hover .dshgv-node-box{fill:var(--gv-surface-2)}',
      '.dshgv-node.status-ok .dshgv-node-box{stroke:rgba(34,197,94,.8)}',
      '.dshgv-node.status-failed .dshgv-node-box{stroke:rgba(239,68,68,.8)}',
      '.dshgv-node.status-pending .dshgv-node-box{stroke:rgba(71,85,105,.85);stroke-dasharray:5 3}',
      '.dshgv-node.on-path .dshgv-node-box{stroke:var(--gv-amber);stroke-width:1.8;stroke-dasharray:none}',
      '.dshgv-node.selected .dshgv-node-box{stroke:var(--gv-amber);stroke-width:2.5;fill:var(--gv-surface-2);stroke-dasharray:none}',
      '.dshgv-node-focus{fill:none;stroke:var(--gv-focus);stroke-width:2;opacity:0;transition:opacity 160ms ease;pointer-events:none}',
      '.dshgv-node:focus-visible .dshgv-node-focus{opacity:1}',
      '.dshgv-node-bar.ok{fill:var(--gv-ok)}',
      '.dshgv-node-bar.failed{fill:var(--gv-failed)}',
      '.dshgv-node-bar.pending{fill:#64748B}',
      '.dshgv-node-id{font-family:var(--gv-mono);font-size:12px;font-weight:600;fill:var(--gv-fg)}',
      '.dshgv-node-meta{font-family:var(--gv-mono);font-size:10px;fill:var(--gv-muted)}',
      '.dshgv-node-status{font-family:var(--gv-mono);font-size:10px}',
      '.dshgv-node-status.ok{fill:var(--gv-ok)}',
      '.dshgv-node-status.failed{fill:var(--gv-failed-text)}',
      '.dshgv-node-status.pending{fill:var(--gv-muted)}',
      '.dshgv-node-current{fill:var(--gv-amber);stroke:var(--gv-bg);stroke-width:1}',
      '.dshgv-edge{fill:none;stroke:var(--gv-edge);stroke-width:1.4;stroke-opacity:.5;pointer-events:none}',
      '.dshgv-edge.amber{stroke:var(--gv-amber);stroke-opacity:.95;stroke-width:1.9}',
      /* ---- sidebar ---- */
      '.dshgv-side{width:300px;flex:0 0 300px;overflow:auto;padding:12px 14px 20px;background:var(--gv-surface);border-left:1px solid rgba(71,85,105,.45)}',
      '.dshgv-sec{margin:0 0 16px}',
      '.dshgv-sec:last-child{margin-bottom:0}',
      '.dshgv-sec h4{font-size:10px;line-height:1.2;letter-spacing:.1em;text-transform:uppercase;color:var(--gv-muted);margin:0 0 6px;font-weight:600}',
      '.dshgv-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}',
      '.dshgv-row{width:100%;display:flex;align-items:baseline;gap:7px;text-align:left;background:transparent;border:1px solid transparent;border-radius:6px;padding:4px 6px;cursor:pointer;font-size:11px;line-height:1.45;color:var(--gv-muted);transition:background-color 160ms ease,border-color 160ms ease,color 160ms ease}',
      '.dshgv-row:hover{background:var(--gv-surface-2);color:var(--gv-fg)}',
      '.dshgv-row[aria-pressed="true"]{background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.5);color:var(--gv-fg)}',
      '.dshgv-row b{font-family:var(--gv-mono);font-size:11px;font-weight:600;color:var(--gv-fg);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshgv-row .dshgv-sp{font-family:var(--gv-mono);font-size:10px;color:var(--gv-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '.dshgv-st{font-family:var(--gv-mono);font-size:10px;white-space:nowrap;margin-left:auto}',
      '.dshgv-st.ok{color:var(--gv-ok)}',
      '.dshgv-st.failed{color:var(--gv-failed-text)}',
      '.dshgv-st.pending{color:var(--gv-muted)}',
      '.dshgv-none{margin:0;font-size:11px;color:var(--gv-muted)}',
      '.dshgv-rationale{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}',
      '.dshgv-rationale li{font-size:11px;line-height:1.5;color:var(--gv-muted);padding-left:9px;position:relative;overflow-wrap:anywhere}',
      '.dshgv-rationale li::before{content:"";position:absolute;left:0;top:.55em;width:3px;height:3px;border-radius:50%;background:#64748B}',
      '.dshgv-hint{margin:0;font-size:11px;line-height:1.5;color:var(--gv-muted)}',
      '.dshgv-inspect{border:1px solid rgba(71,85,105,.6);border-radius:8px;background:var(--gv-bg);padding:10px 11px}',
      '.dshgv-inspect-head{display:flex;align-items:baseline;gap:8px;min-width:0;margin-bottom:4px}',
      '.dshgv-inspect-head b{font-family:var(--gv-mono);font-size:12px;color:var(--gv-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshgv-kind{font:10px/1.2 var(--gv-mono);color:var(--gv-muted);white-space:nowrap;margin-left:auto}',
      '.dshgv-kv{display:flex;gap:8px;align-items:baseline;font-size:11px;line-height:1.6;color:var(--gv-muted)}',
      '.dshgv-kv b{font-family:var(--gv-mono);font-size:10px;font-weight:500;color:var(--gv-fg)}',
      '.dshgv-kv .dshgv-st{margin-left:0}',
      '.dshgv-instruction{margin:8px 0 0;font-size:11px;line-height:1.55;color:#CBD5E1;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dshgv-instruction.dim{color:var(--gv-muted)}',
      '.dshgv-tools-head{margin:10px 0 2px;font:10px/1.2 var(--gv-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--gv-muted)}',
      '.dshgv-tools{list-style:none;margin:0;padding:0}',
      '.dshgv-tool{display:flex;align-items:center;gap:7px;font:11px/1.5 var(--gv-mono);padding:4px 0;border-top:1px solid rgba(71,85,105,.22);min-width:0}',
      '.dshgv-tool:first-child{border-top:0}',
      '.dshgv-mark{width:12px;flex:0 0 12px;text-align:center;font-size:10px}',
      '.dshgv-mark.ok{color:var(--gv-ok)}',
      '.dshgv-mark.bad{color:var(--gv-failed-text)}',
      '.dshgv-tool-name{flex:1 1 auto;color:var(--gv-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.dshgv-link{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;background:none;border:1px solid transparent;padding:0 4px;border-radius:4px;color:var(--gv-muted);font:11px/1 var(--gv-mono);cursor:pointer;white-space:nowrap;transition:color 160ms ease,background-color 160ms ease,border-color 160ms ease}',
      '.dshgv-link:hover{color:var(--gv-fg);background:var(--gv-surface-2);border-color:rgba(71,85,105,.6)}',
            /* ---- empty ---- */
      '.dshgv-empty{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:40px 24px;text-align:center;color:var(--gv-muted)}',
      '.dshgv-empty p{margin:0;max-width:440px;font-size:12px;line-height:1.6}',
      '.dshgv-empty-icon{opacity:.8}',
      '.dshgv-error{margin:0;color:var(--gv-failed-text);font:11px/1.5 var(--gv-mono);max-width:560px;overflow-wrap:anywhere}',
      /* ---- scrollbars, motion, breakpoints ---- */
      '.dshgv-side::-webkit-scrollbar,.dshgv-detail-canvas::-webkit-scrollbar{width:10px;height:10px}',
      '.dshgv-side::-webkit-scrollbar-thumb,.dshgv-detail-canvas::-webkit-scrollbar-thumb{background:#334155;border-radius:6px;border:2px solid var(--gv-bg)}',
      '@keyframes dshgv-fade{from{opacity:0}to{opacity:1}}',
      '@media (max-width:900px){.dshgv-detail{flex-direction:column}.dshgv-side{width:auto;flex:1 1 auto;max-height:46%;border-left:0;border-top:1px solid rgba(71,85,105,.45)}.dshgv-legend{gap:7px}.dshgv-bar{gap:8px}}',
      '@media (prefers-reduced-motion:reduce){.dshgv *,.dshgv *::before,.dshgv *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}}'
    ].join('')

    function injectStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      var tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ------------------------------------------------------------------ */
    /* small utilities                                                      */
    /* ------------------------------------------------------------------ */

    function clamp(value, min, max) {
      return value < min ? min : value > max ? max : value
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function hash32(text) {
      var hash = 2166136261
      for (var i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
      }
      return hash >>> 0
    }

    /** Deterministic PRNG so a given graph signature always looks the same. */
    function seeded(seed) {
      var state = seed >>> 0
      return function () {
        state = (state + 0x6D2B79F5) | 0
        var t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    function truncate(value, max) {
      var text = String(value == null ? '' : value)
      return text.length > max ? text.slice(0, max - 1) + '\u2026' : text
    }

    function isPlanNode(node) {
      return node !== null && typeof node === 'object' && typeof node.id === 'string' && node.id.length > 0
    }

    function planOf(turn) {
      return turn !== null && typeof turn === 'object' && turn.plan !== null && typeof turn.plan === 'object'
        ? turn.plan
        : null
    }

    function planNodesOf(turn) {
      var plan = planOf(turn)
      return plan === null ? [] : asArray(plan.nodes).filter(isPlanNode)
    }

    function trailOf(turn) {
      return asArray(turn !== null && typeof turn === 'object' ? turn.trail : null).filter(function (step) {
        return step !== null && typeof step === 'object' && typeof step.id === 'string'
      })
    }

    /** Turn-level state: any failed trail row wins, then any ok row. */
    function turnStatus(turn) {
      var trail = trailOf(turn)
      var failed = turn !== null && typeof turn === 'object' && (turn.status === 'failed' || turn.status === 'aborted')
      var ok = false
      for (var i = 0; i < trail.length; i++) {
        if (trail[i].status === 'failed') failed = true
        if (trail[i].status === 'ok') ok = true
      }
      return failed ? 'failed' : ok ? 'ok' : 'pending'
    }

    function stepStatus(step) {
      if (step !== null && typeof step === 'object' && step.status === 'failed') return 'failed'
      if (step !== null && typeof step === 'object' && step.status === 'ok') return 'ok'
      return 'pending'
    }

    function statusGlyph(status) {
      return status === 'ok' ? '\u2713' : status === 'failed' ? '\u2715' : '\u25CB'
    }

    function statusWord(status, tr) {
      return tr(status === 'ok' ? 'ok' : status === 'failed' ? 'failed' : 'pending')
    }

    function nodeRadius(item, degree) {
      var steps = Math.max(0, item.stepCount || 0)
      var nodes = Math.max(0, item.nodeCount || 0)
      return clamp(4.6 + 0.55 * Math.sqrt(steps) + 0.45 * Math.sqrt(Math.max(0, degree || 0)) + 0.06 * Math.min(nodes, 40), 4.6, 10)
    }

    function planToolKeys(turn, includeTrail) {
      var keys = new Set()
      planNodesOf(turn).forEach(function (node) {
        asArray(node.toolAllow).forEach(function (name) {
          if (typeof name === 'string' && name.length > 0) keys.add('t:' + name)
        })
        if (node.kind === 'tool-call' && typeof node.capabilityId === 'string' && node.capabilityId.length > 0) {
          keys.add('t:' + node.capabilityId)
        }
      })
      // Trailing tool rows are stable once a turn is in the history; a live
      // turn deliberately contributes plan-declared tools only, so a poll that
      // grows its trail never changes the layout signature.
      if (includeTrail) {
        trailOf(turn).forEach(function (step) {
          asArray(step.tools).forEach(function (tool) {
            if (tool !== null && typeof tool === 'object' && typeof tool.name === 'string' && tool.name.length > 0) {
              keys.add('t:' + tool.name)
            }
          })
        })
      }
      return keys
    }

    /* ------------------------------------------------------------------ */
    /* overview model: turns are nodes, links are sequence + shared keys    */
    /* ------------------------------------------------------------------ */

    function overviewModel(turns, live) {
      var source = []
      asArray(turns).forEach(function (turn) {
        if (turn !== null && typeof turn === 'object') source.push({ data: turn, live: false })
      })
      if (live !== null && typeof live === 'object' && (planOf(live) !== null || trailOf(live).length > 0)) {
        source.push({ data: live, live: true })
      }
      var nodes = source.map(function (entry, index) {
        var trail = trailOf(entry.data)
        return {
          key: 't' + index,
          index: index,
          number: index + 1,
          data: entry.data,
          live: entry.live,
          stepCount: Math.max(trail.length, typeof entry.data.step === 'number' ? entry.data.step : 0),
          nodeCount: planNodesOf(entry.data).length,
          status: turnStatus(entry.data)
        }
      })

      var edges = []
      var seen = new Set()
      var degree = {}
      function pairKey(a, b) {
        return a < b ? a + ':' + b : b + ':' + a
      }
      function addEdge(a, b, kind) {
        var key = pairKey(a, b)
        if (seen.has(key)) return false
        seen.add(key)
        edges.push({ a: a, b: b, kind: kind, key: key })
        degree[a] = (degree[a] || 0) + 1
        degree[b] = (degree[b] || 0) + 1
        return true
      }

      // Consecutive turns form the backbone.
      for (var i = 0; i + 1 < nodes.length; i++) addEdge(i, i + 1, 'sequence')

      // Then link turns that share a plan node id or a tool name. Sharing one
      // key is one link; each node stays at six links or fewer.
      var owners = new Map()
      nodes.forEach(function (node, index) {
        var keys = new Set()
        planNodesOf(node.data).forEach(function (planNode) { keys.add('n:' + planNode.id) })
        planToolKeys(node.data, !node.live).forEach(function (key) { keys.add(key) })
        keys.forEach(function (key) {
          if (!owners.has(key)) owners.set(key, [])
          owners.get(key).push(index)
        })
      })
      owners.forEach(function (list) {
        for (var a = 0; a < list.length; a++) {
          for (var b = a + 1; b < list.length; b++) {
            var left = list[a]
            var right = list[b]
            if ((degree[left] || 0) >= 6 || (degree[right] || 0) >= 6) continue
            addEdge(left, right, 'shared')
          }
        }
      })

      // Layout signature: ids, per-turn plan size and the link set. Statuses
      // and trail rows are absent on purpose, so polling never relayouts.
      var signature = nodes
        .map(function (node) { return node.key + ':' + node.nodeCount })
        .join(',') + '|' + edges.map(function (edge) { return edge.a + '>' + edge.b }).join(',')

      return { nodes: nodes, edges: edges, degree: degree, signature: signature }
    }

    /* ------------------------------------------------------------------ */
    /* deterministic force layout                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Spring-electrical layout: repulsion between every pair, spring per link,
     * light centering and a collision radius. Position is seeded from the
     * signature, so the same turn set always settles into the same picture.
     * 300 synchronous ticks (220 for very wide nets) - no animation loop, no
     * per-poll work.
     */
    function simulate(count, edges, seed) {
      if (count <= 0) return []
      if (count === 1) return [{ x: 0, y: 0 }]

      var random = seeded(seed)
      var points = []
      var velocities = []
      var ring = 40 + 34 * Math.sqrt(count)
      for (var i = 0; i < count; i++) {
        var angle = (i / count) * Math.PI * 2 + random() * 0.3
        points.push({ x: Math.cos(angle) * ring, y: Math.sin(angle) * ring })
        velocities.push({ x: 0, y: 0 })
      }

      var idealLength = 170
      var repulsion = 8000
      var spring = 0.035
      var gravity = 0.004
      var damping = 0.86
      var maxSpeed = 6
      var minGap = 18
      var iterations = count > 60 ? 220 : 300
      var forceX = new Array(count)
      var forceY = new Array(count)

      for (var tick = 0; tick < iterations; tick++) {
        for (i = 0; i < count; i++) {
          forceX[i] = 0
          forceY[i] = 0
        }

        // Repulsion.
        for (i = 0; i < count; i++) {
          for (var j = i + 1; j < count; j++) {
            var dx = points[j].x - points[i].x
            var dy = points[j].y - points[i].y
            var distance = Math.sqrt(dx * dx + dy * dy)
            if (distance < 0.01) {
              dx = random() - 0.5
              dy = random() - 0.5
              distance = Math.sqrt(dx * dx + dy * dy) || 1
            }
            var push = repulsion / (distance * distance)
            var ux = dx / distance
            var uy = dy / distance
            forceX[i] -= ux * push
            forceY[i] -= uy * push
            forceX[j] += ux * push
            forceY[j] += uy * push
          }
        }

        // Springs along links.
        for (i = 0; i < edges.length; i++) {
          var edge = edges[i]
          var ax = points[edge.a].x
          var ay = points[edge.a].y
          var bx = points[edge.b].x
          var by = points[edge.b].y
          dx = bx - ax
          dy = by - ay
          distance = Math.sqrt(dx * dx + dy * dy) || 0.01
          var pull = (distance - idealLength) * spring
          ux = dx / distance
          uy = dy / distance
          forceX[edge.a] += ux * pull
          forceY[edge.a] += uy * pull
          forceX[edge.b] -= ux * pull
          forceY[edge.b] -= uy * pull
        }

        // Centering + collision, then integrate with velocity damping.
        for (i = 0; i < count; i++) {
          forceX[i] -= points[i].x * gravity
          forceY[i] -= points[i].y * gravity
        }
        for (i = 0; i < count; i++) {
          for (j = i + 1; j < count; j++) {
            dx = points[j].x - points[i].x
            dy = points[j].y - points[i].y
            distance = Math.sqrt(dx * dx + dy * dy) || 0.01
            if (distance < minGap) {
              var split = (minGap - distance) * 0.12
              ux = dx / distance
              uy = dy / distance
              forceX[i] -= ux * split
              forceY[i] -= uy * split
              forceX[j] += ux * split
              forceY[j] += uy * split
            }
          }
        }
        for (i = 0; i < count; i++) {
          velocities[i].x = (velocities[i].x + forceX[i]) * damping
          velocities[i].y = (velocities[i].y + forceY[i]) * damping
          var speed = Math.sqrt(velocities[i].x * velocities[i].x + velocities[i].y * velocities[i].y)
          if (speed > maxSpeed) {
            velocities[i].x = (velocities[i].x / speed) * maxSpeed
            velocities[i].y = (velocities[i].y / speed) * maxSpeed
          }
          points[i].x += velocities[i].x
          points[i].y += velocities[i].y
        }
      }

      // Center the settled net on the origin.
      var minX = Infinity
      var maxX = -Infinity
      var minY = Infinity
      var maxY = -Infinity
      for (i = 0; i < count; i++) {
        if (points[i].x < minX) minX = points[i].x
        if (points[i].x > maxX) maxX = points[i].x
        if (points[i].y < minY) minY = points[i].y
        if (points[i].y > maxY) maxY = points[i].y
      }
      var centerX = (minX + maxX) / 2
      var centerY = (minY + maxY) / 2
      for (i = 0; i < count; i++) {
        points[i].x -= centerX
        points[i].y -= centerY
      }
      return points
    }

    function fitView(points, width, height) {
      if (width <= 0 || height <= 0) return { k: 1, x: 0, y: 0 }
      if (points.length === 0) return { k: 1, x: width / 2, y: height / 2 }
      var minX = Infinity
      var maxX = -Infinity
      var minY = Infinity
      var maxY = -Infinity
      for (var i = 0; i < points.length; i++) {
        if (points[i].x - 14 < minX) minX = points[i].x - 14
        if (points[i].x + 14 > maxX) maxX = points[i].x + 14
        if (points[i].y - 14 < minY) minY = points[i].y - 14
        if (points[i].y + 26 > maxY) maxY = points[i].y + 26
      }
      var spanX = Math.max(1, maxX - minX)
      var spanY = Math.max(1, maxY - minY)
      var pad = 36
      var k = clamp(Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY), 0.12, 1.4)
      return {
        k: k,
        x: width / 2 - ((minX + maxX) / 2) * k,
        y: height / 2 - ((minY + maxY) / 2) * k
      }
    }

    /* ------------------------------------------------------------------ */
    /* drill-in layout: depth columns + node-link edges                    */
    /* ------------------------------------------------------------------ */

    var NODE_W = 190
    var NODE_H = 60
    var GAP_X = 24
    var GAP_Y = 24
    var PAD = 28

    function layoutTurn(turn) {
      var rawNodes = planNodesOf(turn)
      var plan = planOf(turn)
      var rawEdges = plan === null ? [] : asArray(plan.edges)
      var byId = new Map()
      rawNodes.forEach(function (node) { byId.set(node.id, node) })

      var outgoing = new Map()
      var inDegree = new Map()
      rawNodes.forEach(function (node) { inDegree.set(node.id, 0) })
      rawEdges.forEach(function (edge) {
        if (edge === null || typeof edge !== 'object') return
        if (!byId.has(edge.from) || !byId.has(edge.to)) return
        if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
        outgoing.get(edge.from).push(edge.to)
        inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1)
      })

      // Breadth-first depth from the entry (or all roots when the plan has no
      // usable entry). Revisits only survive when they shorten a depth, so a
      // cycle becomes a back edge instead of an infinite walk.
      var depth = new Map()
      var roots = []
      if (plan !== null && typeof plan.entry === 'string' && byId.has(plan.entry)) {
        roots.push(plan.entry)
      } else {
        rawNodes.forEach(function (node) {
          if ((inDegree.get(node.id) || 0) === 0) roots.push(node.id)
        })
      }
      if (roots.length === 0 && rawNodes.length > 0) roots.push(rawNodes[0].id)
      var queue = roots.map(function (id) { return [id, 0] })
      var head = 0
      var guard = 0
      var maxDepth = 0
      while (head < queue.length && guard < 50000) {
        guard++
        var current = queue[head++]
        var id = current[0]
        var level = current[1]
        if (!byId.has(id)) continue
        var known = depth.get(id)
        if (known !== undefined && known <= level) continue
        depth.set(id, level)
        if (level > maxDepth) maxDepth = level
        var targets = outgoing.get(id) || []
        for (var t = 0; t < targets.length; t++) {
          if (level + 1 > rawNodes.length) continue
          var targetDepth = depth.get(targets[t])
          if (targetDepth === undefined || targetDepth > level + 1) queue.push([targets[t], level + 1])
        }
      }
      rawNodes.forEach(function (node) {
        if (!depth.has(node.id)) depth.set(node.id, maxDepth + 1)
      })

      // Compress used depths to contiguous columns (a sparse depth must not
      // leave huge horizontal holes), and sort each column by id for stability.
      var used = []
      depth.forEach(function (value) {
        if (used.indexOf(value) === -1) used.push(value)
      })
      used.sort(function (a, b) { return a - b })
      var rank = new Map()
      used.forEach(function (value, index) { rank.set(value, index) })
      var columns = new Map()
      rawNodes.forEach(function (node) {
        var column = rank.get(depth.get(node.id))
        if (!columns.has(column)) columns.set(column, [])
        columns.get(column).push(node)
      })
      columns.forEach(function (list) {
        list.sort(function (a, b) { return String(a.id).localeCompare(String(b.id)) })
      })
      var columnKeys = []
      columns.forEach(function (list, column) { columnKeys.push(column) })
      columnKeys.sort(function (a, b) { return a - b })

      var position = new Map()
      var ordered = []
      var rows = 1
      columnKeys.forEach(function (column) {
        var list = columns.get(column)
        if (list.length > rows) rows = list.length
        list.forEach(function (node, row) {
          var point = {
            node: node,
            x: PAD + column * (NODE_W + GAP_X),
            y: PAD + row * (NODE_H + GAP_Y),
            column: column,
            row: row
          }
          position.set(node.id, point)
          ordered.push(point)
        })
      })

      var columnCount = columns.size
      var width = PAD * 2 + columnCount * NODE_W + Math.max(0, columnCount - 1) * GAP_X
      var blockBottom = PAD * 2 + rows * NODE_H + Math.max(0, rows - 1) * GAP_Y
      var laneBase = blockBottom + 18
      var backCount = 0
      var routed = []
      rawEdges.forEach(function (edge) {
        if (edge === null || typeof edge !== 'object') return
        var from = position.get(edge.from)
        var to = position.get(edge.to)
        if (!from || !to) return
        var back = from.column >= to.column
        var lane = 0
        if (back) {
          lane = backCount
          backCount++
        }
        routed.push({ from: from, to: to, back: back, lane: lane, edge: edge })
      })
      var height = backCount > 0
        ? laneBase + (backCount - 1) * 16 + 18
        : blockBottom + PAD

      return {
        nodes: ordered,
        edges: routed,
        width: Math.max(width, 1),
        height: Math.max(height, 1),
        laneBase: laneBase,
        rows: rows
      }
    }

    function forwardPath(from, to) {
      var x1 = from.x + NODE_W
      var y1 = from.y + NODE_H / 2
      var x2 = to.x
      var y2 = to.y + NODE_H / 2
      var mid = (x1 + x2) / 2
      return 'M ' + x1 + ' ' + y1 + ' C ' + mid + ' ' + y1 + ', ' + mid + ' ' + y2 + ', ' + x2 + ' ' + y2
    }

    /**
     * Back and same-column edges take a rounded detour below the whole node
     * block. The vertical runs sit in the empty gutter beside each column
     * (never under a node centre), so every segment is either in a gutter or
     * below the block and no node rect can be crossed. Same-column edges enter
     * the target from its left edge; other back edges enter from the right.
     */
    function backPath(from, to, laneY) {
      var radius = 8
      var sameColumn = from.column === to.column
      var sourceGutter = from.x + NODE_W + 12
      var targetGutter = sameColumn ? to.x - 12 : to.x + NODE_W + 12
      var startX = from.x + NODE_W
      var startY = from.y + NODE_H / 2
      var endX = sameColumn ? to.x : to.x + NODE_W
      var endY = to.y + NODE_H / 2
      var direction = targetGutter >= sourceGutter ? 1 : -1
      var path = 'M ' + startX + ' ' + startY
      path += ' L ' + (sourceGutter - radius) + ' ' + startY
      path += ' Q ' + sourceGutter + ' ' + startY + ' ' + sourceGutter + ' ' + (startY + radius)
      path += ' L ' + sourceGutter + ' ' + (laneY - radius)
      path += ' Q ' + sourceGutter + ' ' + laneY + ' ' + (sourceGutter + direction * radius) + ' ' + laneY
      path += ' L ' + (targetGutter - direction * radius) + ' ' + laneY
      path += ' Q ' + targetGutter + ' ' + laneY + ' ' + targetGutter + ' ' + (laneY - radius)
      path += ' L ' + targetGutter + ' ' + (endY + radius)
      path += ' Q ' + targetGutter + ' ' + endY + ' ' + (targetGutter - direction * radius) + ' ' + endY
      path += ' L ' + endX + ' ' + endY
      return path
    }

    function defaultSelectedNode(turn, nodes, trail) {
      if (trail.length > 0) return trail[trail.length - 1].id
      if (nodes.length > 0) return nodes[0].node.id
      return null
    }

    /* ------------------------------------------------------------------ */
    /* overview                                                             */
    /* ------------------------------------------------------------------ */

    function Overview(props) {
      var model = props.model
      var tr = props.tr
      var onDrill = props.onDrill
      var selectedKey = props.selectedKey

      var layout = React.useMemo(function () {
        return simulate(model.nodes.length, model.edges, hash32(model.signature))
      }, [model.signature])

      var [pointsState, setPointsState] = React.useState({ signature: model.signature, points: layout })
      var [size, setSize] = React.useState({ width: 0, height: 0 })
      var [view, setView] = React.useState({ k: 1, x: 0, y: 0 })
      var [hoverId, setHoverId] = React.useState(null)
      var [focusId, setFocusId] = React.useState(null)
      var [dragging, setDragging] = React.useState(false)

      var stageRef = React.useRef(null)
      var svgRef = React.useRef(null)
      var dragRef = React.useRef(null)
      var suppressClickRef = React.useRef(false)
      var viewRef = React.useRef(view)
      viewRef.current = view
      var fittedRef = React.useRef('')
      var points = pointsState.signature === model.signature ? pointsState.points : layout
      var pointsRef = React.useRef(points)
      pointsRef.current = points

      React.useEffect(function () {
        setPointsState(function (previous) {
          if (previous.signature === model.signature) return previous
          return { signature: model.signature, points: layout }
        })
      }, [layout, model.signature])

      React.useEffect(function () {
        var node = stageRef.current
        if (!node || typeof node.getBoundingClientRect !== 'function') return
        var measure = function () {
          var rect = node.getBoundingClientRect()
          var width = Math.max(0, Math.round(rect.width * 100) / 100)
          var height = Math.max(0, Math.round(rect.height * 100) / 100)
          setSize(function (previous) {
            return previous.width === width && previous.height === height
              ? previous
              : { width: width, height: height }
          })
        }
        measure()
        if (typeof ResizeObserver !== 'undefined') {
          var observer = new ResizeObserver(measure)
          observer.observe(node)
          return function () { observer.disconnect() }
        }
        if (typeof window !== 'undefined') {
          window.addEventListener('resize', measure)
          return function () { window.removeEventListener('resize', measure) }
        }
      }, [])

      React.useEffect(function () {
        if (size.width < 1 || size.height < 1) return
        var stamp = model.signature + '@' + Math.round(size.width) + 'x' + Math.round(size.height)
        if (fittedRef.current === stamp) return
        fittedRef.current = stamp
        setView(fitView(layout, size.width, size.height))
      }, [layout, size, model.signature])

      var neighbors = React.useMemo(function () {
        var map = {}
        model.edges.forEach(function (edge) {
          var a = model.nodes[edge.a]
          var b = model.nodes[edge.b]
          if (!a || !b) return
          if (!map[a.key]) map[a.key] = {}
          if (!map[b.key]) map[b.key] = {}
          map[a.key][b.key] = true
          map[b.key][a.key] = true
        })
        return map
      }, [model.signature])

      var topLabelKeys = React.useMemo(function () {
        var ranked = model.nodes.slice().sort(function (a, b) {
          return (model.degree[b.key] || 0) - (model.degree[a.key] || 0) || a.index - b.index
        })
        var keys = new Set()
        for (var i = 0; i < ranked.length && i < 3; i++) keys.add(ranked[i].key)
        return keys
      }, [model.signature])

      function applyZoom(pixelX, pixelY, factor) {
        var current = viewRef.current
        var nextK = clamp(current.k * factor, 0.12, 5)
        if (nextK === current.k) return
        setView({
          k: nextK,
          x: pixelX - (pixelX - current.x) * (nextK / current.k),
          y: pixelY - (pixelY - current.y) * (nextK / current.k)
        })
      }

      function fitNow() {
        if (size.width < 1 || size.height < 1) return
        setView(fitView(pointsRef.current, size.width, size.height))
      }

      function zoomBy(factor) {
        applyZoom(size.width / 2, size.height / 2, factor)
      }

      React.useEffect(function () {
        var svg = svgRef.current
        if (!svg || typeof svg.addEventListener !== 'function') return
        var onWheel = function (event) {
          event.preventDefault()
          var rect = svg.getBoundingClientRect()
          var pixelX = event.clientX - rect.left
          var pixelY = event.clientY - rect.top
          var factor = clamp(Math.exp(-event.deltaY * 0.0015), 0.8, 1.25)
          applyZoom(pixelX, pixelY, factor)
        }
        svg.addEventListener('wheel', onWheel, { passive: false })
        return function () { svg.removeEventListener('wheel', onWheel) }
      }, [])

      // Drag state lives in refs and its listeners live on window. Pointer
      // capture would retarget the compatibility click event to the SVG root,
      // which silently swallowed real clicks on a node.
      var dragMoveRef = React.useRef(null)
      var dragEndRef = React.useRef(null)
      var windowMove = React.useCallback(function (event) {
        if (dragMoveRef.current) dragMoveRef.current(event)
      }, [])
      var windowEnd = React.useCallback(function (event) {
        if (dragEndRef.current) dragEndRef.current(event)
      }, [])

      function removeDragListeners() {
        if (typeof window === 'undefined') return
        window.removeEventListener('pointermove', windowMove)
        window.removeEventListener('pointerup', windowEnd)
        window.removeEventListener('pointercancel', windowEnd)
        window.removeEventListener('blur', windowEnd)
      }

      function addDragListeners() {
        if (typeof window === 'undefined') return
        window.addEventListener('pointermove', windowMove)
        window.addEventListener('pointerup', windowEnd)
        window.addEventListener('pointercancel', windowEnd)
        window.addEventListener('blur', windowEnd)
      }

      function onBackgroundDown(event) {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        // No preventDefault here: cancelling pointerdown suppresses the
        // compatibility click/dblclick events, and dblclick is Fit.
        dragRef.current = {
          type: 'pan',
          startX: event.clientX,
          startY: event.clientY,
          view: viewRef.current,
          moved: false
        }
        setDragging(true)
        addDragListeners()
      }

      function onNodeDown(event, index) {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        event.stopPropagation()
        var point = points[index]
        if (!point) return
        suppressClickRef.current = false
        dragRef.current = {
          type: 'node',
          index: index,
          startX: event.clientX,
          startY: event.clientY,
          originX: point.x,
          originY: point.y,
          moved: false
        }
        setDragging(true)
        addDragListeners()
      }

      function onPointerMove(event) {
        var drag = dragRef.current
        if (!drag) return
        var dx = event.clientX - drag.startX
        var dy = event.clientY - drag.startY
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
        if (drag.type === 'pan') {
          setView({
            k: drag.view.k,
            x: drag.view.x + dx,
            y: drag.view.y + dy
          })
          return
        }
        var scale = viewRef.current.k
        setPointsState(function (previous) {
          var base = previous.signature === model.signature ? previous.points : layout
          var next = base.slice()
          next[drag.index] = {
            x: drag.originX + dx / scale,
            y: drag.originY + dy / scale
          }
          return { signature: model.signature, points: next }
        })
      }

      function onPointerUp(event) {
        var drag = dragRef.current
        if (!drag) return
        dragRef.current = null
        setDragging(false)
        removeDragListeners()
        if (drag.type === 'node') {
          suppressClickRef.current = drag.moved
          // A drag that ends outside the canvas (or a touch lift) must not
          // leave the net dimmed around a node the pointer no longer visits.
          if (event && event.type === 'blur') {
            setHoverId(null)
          } else if (event && event.pointerType === 'touch') {
            setHoverId(null)
          } else if (event && svgRef.current && typeof event.clientX === 'number') {
            var rect = svgRef.current.getBoundingClientRect()
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
              setHoverId(null)
            }
          }
        }
      }

      dragMoveRef.current = onPointerMove
      dragEndRef.current = onPointerUp

      React.useEffect(function () {
        return function () {
          removeDragListeners()
          dragRef.current = null
        }
      }, [])

      function onNodeClick(item) {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        onDrill(item)
      }

      function focusNodeAt(index) {
        if (index < 0 || index >= model.nodes.length) return
        if (typeof document === 'undefined') return
        var element = document.getElementById('dshgv-ov-' + model.nodes[index].key)
        if (element && element.focus) element.focus()
      }

      function onNodeKeyDown(event, index) {
        var key = event.key
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
          event.preventDefault()
          onDrill(model.nodes[index])
          return
        }
        if (key === 'ArrowRight' || key === 'ArrowDown') {
          event.preventDefault()
          focusNodeAt(Math.min(model.nodes.length - 1, index + 1))
          return
        }
        if (key === 'ArrowLeft' || key === 'ArrowUp') {
          event.preventDefault()
          focusNodeAt(Math.max(0, index - 1))
          return
        }
        if (key === 'Home') {
          event.preventDefault()
          focusNodeAt(0)
          return
        }
        if (key === 'End') {
          event.preventDefault()
          focusNodeAt(model.nodes.length - 1)
        }
      }

      var activeKey = hoverId || focusId
      var activeNeighbors = activeKey ? neighbors[activeKey] || {} : null
      var activeIndex = -1
      for (var n = 0; n < model.nodes.length; n++) {
        if (model.nodes[n].key === activeKey) { activeIndex = n; break }
      }

      // Labels keep a 12px screen size while the net zooms: a 100-turn fit is
      // ~60%, where scaled 12px text would be illegible.
      var labelScale = Math.max(view.k, 0.12)
      var nodeElements = model.nodes.map(function (item, index) {
        var point = points[index]
        if (!point) return null
        var degree = model.degree[item.key] || 0
        var radius = nodeRadius(item, degree)
        var selected = item.key === selectedKey
        var dimmed = activeKey !== null && item.key !== activeKey && !(activeNeighbors && activeNeighbors[item.key])
        var labelOn = item.key === activeKey || selected || topLabelKeys.has(item.key)
        var fill = selected ? C.amber : item.status === 'failed' ? C.failed : item.status === 'ok' ? C.ok : C.muted2
        var outline = selected ? '#B45309' : item.status === 'failed' ? '#991B1B' : item.status === 'ok' ? '#15803D' : C.border
        var label = tr('turn') + ' ' + item.number
        var aria = label + ', ' + statusWord(item.status, tr) + ', ' + item.stepCount + ' ' + tr(item.stepCount === 1 ? 'step' : 'steps') +
          (item.live ? ', ' + tr('live') : '')
        return h('g', {
          key: item.key,
          id: 'dshgv-ov-' + item.key,
          className: 'dshgv-ov-node' + (activeKey === item.key ? ' active' : '') + (selected ? ' selected' : ''),
          transform: 'translate(' + point.x + ' ' + point.y + ')',
          tabIndex: 0,
          focusable: 'true',
          role: 'button',
          'aria-label': aria,
          'aria-pressed': selected ? 'true' : 'false',
          style: { opacity: dimmed ? 0.25 : 1 },
          onPointerDown: function (event) { onNodeDown(event, index) },
          onClick: function () { onNodeClick(item) },
          onPointerEnter: function () { setHoverId(item.key) },
          onPointerLeave: function () {
            setHoverId(function (previous) { return previous === item.key ? null : previous })
          },
          onFocus: function (event) {
            var visible = true
            if (event && event.currentTarget && event.currentTarget.matches) {
              try { visible = event.currentTarget.matches(':focus-visible') } catch (error) { /* older engines */ }
            }
            if (visible) setFocusId(item.key)
          },
          onBlur: function () {
            setFocusId(function (previous) { return previous === item.key ? null : previous })
          },
          onKeyDown: function (event) { onNodeKeyDown(event, index) }
        },
          h('title', null, aria),
          h('circle', { className: 'dshgv-ov-hit', r: radius + 10, fill: 'transparent' }),
          h('circle', { className: 'dshgv-ov-sel', r: radius + 3.5 }),
          h('circle', { className: 'dshgv-ov-ring', r: radius + 3.5 }),
          h('circle', {
            className: 'dshgv-ov-dot',
            r: radius,
            fill: fill,
            stroke: outline,
            strokeWidth: 1
          }),
          labelOn
            ? h('text', {
                className: 'dshgv-ov-label',
                y: radius + 17 / labelScale,
                style: {
                  opacity: dimmed ? 0.25 : 1,
                  fontSize: 12 / labelScale,
                  strokeWidth: 3 / labelScale
                }
              }, label)
            : null
        )
      })

      var edgeElements = model.edges.map(function (edge) {
        var a = points[edge.a]
        var b = points[edge.b]
        if (!a || !b) return null
        var related = activeIndex === -1 || edge.a === activeIndex || edge.b === activeIndex
        var opacity = activeKey === null ? (edge.kind === 'sequence' ? 0.5 : 0.35) : related ? 0.85 : 0.08
        return h('line', {
          key: edge.key,
          className: 'dshgv-ov-edge',
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          stroke: C.edge,
          strokeWidth: 1,
          opacity: opacity,
          'aria-hidden': 'true'
        })
      })

      var legend = [
        { key: 'ok', label: tr('ok'), color: C.ok },
        { key: 'failed', label: tr('failed'), color: C.failed },
        { key: 'pending', label: tr('pending'), color: C.muted2 },
        { key: 'selected', label: tr('selected'), color: C.amber }
      ]

      return h('div', { className: 'dshgv-view' },
        h('div', { className: 'dshgv-bar' },
          h('span', { className: 'dshgv-title' },
            h('b', null, tr('allTurns') + ' \u00B7 ' + model.nodes.length)
          ),
          props.live ? h('span', { className: 'dshgv-live' }, h('i', { 'aria-hidden': 'true' }), tr('live')) : null,
          h('div', { className: 'dshgv-legend', role: 'group', 'aria-label': tr('legend') }, legend.map(function (entry) {
            return h('span', { key: entry.key },
              h('i', { 'aria-hidden': 'true', style: { background: entry.color } }),
              entry.label
            )
          })),
          h('div', { className: 'dshgv-tools', role: 'toolbar', 'aria-label': tr('viewControls') },
            h('button', {
              type: 'button',
              className: 'dshgv-btn',
              'aria-label': tr('zoomOut'),
              title: tr('zoomOut'),
              onClick: function () { zoomBy(0.8) }
            }, '\u2212'),
            h('span', { className: 'dshgv-zoom' }, Math.round(view.k * 100) + '%'),
            h('button', {
              type: 'button',
              className: 'dshgv-btn',
              'aria-label': tr('zoomIn'),
              title: tr('zoomIn'),
              onClick: function () { zoomBy(1.25) }
            }, '+'),
            h('button', {
              type: 'button',
              className: 'dshgv-btn',
              'aria-label': tr('fit'),
              title: tr('fit'),
              onClick: fitNow
            }, tr('fit'))
          )
        ),
        h('div', {
          className: 'dshgv-stage' + (dragging ? ' dragging' : ''),
          ref: stageRef,
          role: 'group',
          'aria-label': tr('overviewAria')
        },
          h('svg', {
            ref: svgRef,
            width: size.width || 1,
            height: size.height || 1,
            viewBox: '0 0 ' + (size.width || 1) + ' ' + (size.height || 1),
            onPointerLeave: function (event) {
              if (dragRef.current) return
              if (event.buttons === 0) setHoverId(null)
            }
          },
            h('rect', {
              className: 'dshgv-bg',
              x: 0,
              y: 0,
              width: size.width || 1,
              height: size.height || 1,
              onPointerDown: onBackgroundDown,
              onDoubleClick: fitNow
            }),
            h('g', { transform: 'translate(' + view.x + ' ' + view.y + ') scale(' + view.k + ')' },
              edgeElements,
              nodeElements
            )
          )
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* drill-in                                                             */
    /* ------------------------------------------------------------------ */

    function DetailSidebar(props) {
      var tr = props.tr
      var turn = props.turn
      var layout = props.layout
      var trail = props.trail
      var trailById = props.trailById
      var selectedId = props.selectedId
      var onSelect = props.onSelect
      var openView = props.openView

      var entries = layout.nodes
      var selectedEntry = null
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].node.id === selectedId) { selectedEntry = entries[i]; break }
      }
      var selectedStep = selectedId === null ? null : trailById.get(selectedId) || null
      var selectedNode = selectedEntry ? selectedEntry.node : null
      var selectedStatus = selectedStep ? stepStatus(selectedStep) : 'pending'

      var flowRows = trail.map(function (step, index) {
        var status = stepStatus(step)
        return h('li', { key: step.id + ':' + index },
          h('button', {
            type: 'button',
            className: 'dshgv-row',
            'aria-pressed': selectedId === step.id ? 'true' : 'false',
            onClick: function () { onSelect(step.id) }
          },
            h('b', null, truncate(step.id, 22)),
            h('span', { className: 'dshgv-sp' }, tr('step') + ' ' + step.step + (step.executor && step.executor !== 'step' ? ' \u00B7 ' + step.executor : '')),
            h('span', { className: 'dshgv-st ' + status }, statusGlyph(status) + ' ' + statusWord(status, tr))
          )
        )
      })

      var nodeRows = entries.map(function (entry) {
        var step = trailById.get(entry.node.id)
        var status = step ? stepStatus(step) : 'pending'
        return h('li', { key: entry.node.id },
          h('button', {
            type: 'button',
            className: 'dshgv-row',
            'aria-pressed': selectedId === entry.node.id ? 'true' : 'false',
            onClick: function () { onSelect(entry.node.id) }
          },
            h('b', null, truncate(entry.node.id, 24)),
            h('span', { className: 'dshgv-sp' }, step ? tr('step') + ' ' + step.step + (entry.node.executor && entry.node.executor !== 'step' ? ' \u00B7 ' + entry.node.executor : '') : (entry.node.executor || 'step')),
            h('span', { className: 'dshgv-st ' + status }, statusGlyph(status) + ' ' + statusWord(status, tr))
          )
        )
      })

      var rationale = asArray(turn && turn.rationale)
      var tools = selectedStep ? asArray(selectedStep.tools) : []

      return h('aside', { className: 'dshgv-side', 'aria-label': tr('detailAria') },
        h('section', { className: 'dshgv-sec' },
          h('h4', null, tr('flow')),
          flowRows.length > 0
            ? h('ul', { className: 'dshgv-list' }, flowRows)
            : h('p', { className: 'dshgv-none' }, tr('noNodes'))
        ),
        h('section', { className: 'dshgv-sec' },
          h('h4', null, tr('rationale')),
          rationale.length > 0
            ? h('ul', { className: 'dshgv-rationale' }, rationale.map(function (line, index) {
                return h('li', { key: index }, String(line))
              }))
            : h('p', { className: 'dshgv-none' }, '\u2014')
        ),
        h('section', { className: 'dshgv-sec' },
          h('h4', null, tr('inspect')),
          selectedId === null
            ? h('p', { className: 'dshgv-hint' }, tr('selectNode'))
            : h('div', { className: 'dshgv-inspect' },
                h('div', { className: 'dshgv-inspect-head' },
                  h('b', { title: selectedId }, truncate(selectedId, 30)),
                  selectedNode ? h('span', { className: 'dshgv-kind' }, selectedNode.kind || 'node') : null
                ),
                h('div', { className: 'dshgv-kv' },
                  h('span', null, tr('executor')),
                  h('b', null, (selectedNode && selectedNode.executor) || (selectedStep && selectedStep.executor) || 'step')
                ),
                selectedStep
                  ? h('div', { className: 'dshgv-kv' }, h('span', null, tr('step')), h('b', null, String(selectedStep.step)))
                  : null,
                h('div', { className: 'dshgv-kv' },
                  h('span', null, tr('status')),
                  h('span', { className: 'dshgv-st ' + selectedStatus },
                    statusGlyph(selectedStatus) + ' ' + statusWord(selectedStatus, tr))
                ),
                h('p', { className: 'dshgv-instruction' + (selectedNode && selectedNode.instruction ? '' : ' dim') },
                  selectedNode && selectedNode.instruction ? String(selectedNode.instruction) : tr('noInstruction')
                ),
                tools.length > 0
                  ? h('div', null,
                      h('div', { className: 'dshgv-tools-head' }, tr('tools')),
                      h('ul', { className: 'dshgv-tools' }, tools.map(function (tool, index) {
                        var bad = tool !== null && typeof tool === 'object' && tool.isError
                        return h('li', { className: 'dshgv-tool', key: (tool && tool.callId) || selectedId + ':tool:' + index },
                          h('span', { className: 'dshgv-mark ' + (bad ? 'bad' : 'ok'), 'aria-hidden': 'true' }, bad ? '\u2715' : '\u2713'),
                          h('span', { className: 'dshgv-sr' }, bad ? tr('failed') : tr('ok')),
                          h('span', { className: 'dshgv-tool-name', title: tool && tool.name }, (tool && tool.name) || 'tool'),
                          openView && tool && tool.callId
                            ? h('button', {
                                type: 'button',
                                className: 'dshgv-link',
                                title: tr('openTrajectory'),
                                'aria-label': tr('openTrajectory') + ': ' + (tool.name || 'tool'),
                                onClick: function () { openView('trajectory', tool.callId) }
                              }, '\u2197')
                            : null
                        )
                      }))
                    )
                  : null
              )
        ),
        h('section', { className: 'dshgv-sec' },
          h('h4', null, tr('nodes')),
          nodeRows.length > 0
            ? h('ul', { className: 'dshgv-list', 'aria-label': tr('nodes') }, nodeRows)
            : h('p', { className: 'dshgv-none' }, tr('noPlan'))
        )
      )
    }

    function TurnDetail(props) {
      var item = props.item
      var tr = props.tr
      var turn = item.data
      var openView = props.openView

      var plan = planOf(turn)
      var layoutKey = plan === null
        ? 'none'
        : (typeof plan.entry === 'string' ? plan.entry : '') + '|' +
          asArray(plan.nodes).map(function (node) { return node && node.id }).join(',') + '|' +
          asArray(plan.edges).map(function (edge) { return edge && (edge.from + '>' + edge.to) }).join(',')
      var layout = React.useMemo(function () { return layoutTurn(turn) }, [layoutKey])

      var trail = trailOf(turn)
      var trailById = new Map()
      trail.forEach(function (step) {
        trailById.set(step.id, step)
      })
      var trailIds = new Set(trail.map(function (step) { return step.id }))
      var trailPairs = new Set()
      for (var i = 0; i + 1 < trail.length; i++) trailPairs.add(trail[i].id + '\u0000' + trail[i + 1].id)
      var currentId = typeof turn.node === 'string' ? turn.node : trail.length > 0 ? trail[trail.length - 1].id : null
      var initialSelected = defaultSelectedNode(turn, layout.nodes, trail)
      var [selectedId, setSelectedId] = React.useState(initialSelected)
      var backRef = React.useRef(null)
      var canvasRef = React.useRef(null)

      React.useEffect(function () {
        setSelectedId(defaultSelectedNode(turn, layout.nodes, trail))
      }, [item.key])

      React.useEffect(function () {
        if (backRef.current && backRef.current.focus) backRef.current.focus()
      }, [item.key])

      function selectNode(id) {
        setSelectedId(id)
      }

      // The detail canvas scrolls horizontally for wide plans; a node picked
      // from the sidebar list must become visible (and the sidebar list is the
      // accessible fallback for the graph).
      function revealNode(id) {
        var index = -1
        for (var i = 0; i < layout.nodes.length; i++) {
          if (layout.nodes[i].node.id === id) { index = i; break }
        }
        if (index < 0 || typeof document === 'undefined') return
        var canvas = canvasRef.current
        var element = document.getElementById('dshgv-dn-' + index)
        if (!canvas || !element || !canvas.getBoundingClientRect) return
        var rect = element.getBoundingClientRect()
        var bounds = canvas.getBoundingClientRect()
        if (rect.left < bounds.left + 24 || rect.right > bounds.right - 24) {
          canvas.scrollLeft += (rect.left + rect.width / 2) - (bounds.left + bounds.width / 2)
        }
        if (rect.top < bounds.top + 24 || rect.bottom > bounds.bottom - 24) {
          canvas.scrollTop += (rect.top + rect.height / 2) - (bounds.top + bounds.height / 2)
        }
      }

      function focusNodeAt(index) {
        if (index < 0 || index >= layout.nodes.length) return
        if (typeof document === 'undefined') return
        var element = document.getElementById('dshgv-dn-' + index)
        if (element && element.focus) element.focus()
      }

      function onNodeKeyDown(event, index) {
        var key = event.key
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
          event.preventDefault()
          selectNode(layout.nodes[index].node.id)
          return
        }
        if (key === 'ArrowRight' || key === 'ArrowDown') {
          event.preventDefault()
          focusNodeAt(Math.min(layout.nodes.length - 1, index + 1))
          return
        }
        if (key === 'ArrowLeft' || key === 'ArrowUp') {
          event.preventDefault()
          focusNodeAt(Math.max(0, index - 1))
        }
      }

      var meta = []
      if (item.live) meta.push(h('span', { key: 'live', className: 'dshgv-live' }, h('i', { 'aria-hidden': 'true' }), tr('live')))
      if (turn.mode) meta.push(h('span', { key: 'mode' }, String(turn.mode)))
      if (turn.replans) meta.push(h('span', { key: 'replans' }, turn.replans + ' ' + tr('replan')))

      var markers = h('defs', null,
        h('marker', {
          id: 'dshgv-arrow',
          viewBox: '0 0 10 10',
          refX: 9,
          refY: 5,
          markerWidth: 7,
          markerHeight: 7,
          orient: 'auto'
        }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: C.edge })),
        h('marker', {
          id: 'dshgv-arrow-amber',
          viewBox: '0 0 10 10',
          refX: 9,
          refY: 5,
          markerWidth: 7,
          markerHeight: 7,
          orient: 'auto'
        }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: C.amber }))
      )

      var edgeElements = layout.edges.map(function (route, index) {
        var amber = trailPairs.has(route.edge.from + '\u0000' + route.edge.to)
        var path = route.back
          ? backPath(route.from, route.to, layout.laneBase + route.lane * 16)
          : forwardPath(route.from, route.to)
        return h('path', {
          key: (route.edge.from || '') + '>' + (route.edge.to || '') + ':' + index,
          className: 'dshgv-edge' + (amber ? ' amber' : ''),
          d: path,
          markerEnd: amber ? 'url(#dshgv-arrow-amber)' : 'url(#dshgv-arrow)'
        })
      })

      var nodeElements = layout.nodes.map(function (entry, index) {
        var node = entry.node
        var step = trailById.get(node.id)
        var status = step ? stepStatus(step) : 'pending'
        var onPath = trailIds.has(node.id)
        var selected = selectedId === node.id
        var current = currentId === node.id
        var metaText = step
          ? tr('step') + ' ' + step.step + (node.executor && node.executor !== 'step' ? ' \u00B7 ' + node.executor : '')
          : (node.executor || 'step')
        var executorText = node.executor || 'step'
        var aria = node.id + ', ' + statusWord(status, tr) + ', ' +
          (step
            ? tr('step') + ' ' + step.step + (executorText !== 'step' ? ' ' + executorText : '')
            : tr('pending') + ', ' + executorText)
        return h('g', {
          key: node.id,
          id: 'dshgv-dn-' + index,
          className: 'dshgv-node status-' + status + (onPath ? ' on-path' : '') + (selected ? ' selected' : '') + (current ? ' current' : ''),
          transform: 'translate(' + entry.x + ' ' + entry.y + ')',
          tabIndex: 0,
          focusable: 'true',
          role: 'button',
          'aria-label': aria,
          'aria-pressed': selected ? 'true' : 'false',
          onClick: function () { selectNode(node.id) },
          onKeyDown: function (event) { onNodeKeyDown(event, index) }
        },
          h('title', null, aria),
          h('rect', { className: 'dshgv-node-focus', x: -4, y: -4, width: NODE_W + 8, height: NODE_H + 8, rx: 13 }),
          h('rect', { className: 'dshgv-node-box', x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 10 }),
          h('rect', { className: 'dshgv-node-bar ' + status, x: 0, y: 0, width: 3, height: NODE_H, rx: 1.5 }),
          current ? h('circle', { className: 'dshgv-node-current', cx: NODE_W - 12, cy: 12, r: 2.6 }) : null,
          h('text', { className: 'dshgv-node-id', x: 12, y: 20 }, truncate(node.id, 22)),
          h('text', { className: 'dshgv-node-meta', x: 12, y: 40 }, truncate(metaText, 28)),
          h('text', { className: 'dshgv-node-status ' + status, x: NODE_W - 12, y: 54, textAnchor: 'end' },
            statusGlyph(status) + ' ' + statusWord(status, tr))
        )
      })

      return h('div', { className: 'dshgv-view' },
        h('div', { className: 'dshgv-bar' },
          h('button', {
            ref: backRef,
            type: 'button',
            className: 'dshgv-btn dshgv-back',
            onClick: props.onBack,
            'aria-label': tr('back'),
            title: tr('back') + ' (Esc)'
          }, '\u2190'),
          h('span', { className: 'dshgv-crumb' },
            h('button', { type: 'button', className: 'dshgv-crumb-link', onClick: props.onBack }, tr('allTurns')),
            h('span', { className: 'dshgv-crumb-sep', 'aria-hidden': 'true' }, '/'),
            h('b', null, tr('turn') + ' ' + item.number)
          ),
          h('span', { className: 'dshgv-meta' }, meta)
        ),
        h('div', { className: 'dshgv-detail' },
          h('div', { className: 'dshgv-detail-canvas', ref: canvasRef },
            layout.nodes.length === 0
              ? h('div', { className: 'dshgv-canvas-empty' }, tr('noPlan'))
              : h('svg', {                  width: layout.width,
                  height: layout.height,
                  viewBox: '0 0 ' + layout.width + ' ' + layout.height,
                  role: 'group',
                  'aria-label': tr('detailAria') + ': ' + tr('turn') + ' ' + item.number
                },
                  markers,
                  edgeElements,
                  nodeElements
                )
          ),
          h(DetailSidebar, {
            tr: tr,
            turn: turn,
            layout: layout,
            trail: trail,
            trailById: trailById,
            selectedId: selectedId,
            onSelect: function (id) { selectNode(id); revealNode(id) },
            openView: openView
          })
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* root                                                                 */
    /* ------------------------------------------------------------------ */

    function GraphBody(props) {
      var t = typeof props.t === 'function' ? props.t : null
      var tr = function (key) {
        var translated = t === null ? null : t(key)
        return translated && translated !== key ? translated : EN[key] || key
      }
      var sessionId = props.sessionId
      var [turns, setTurns] = React.useState([])
      var [live, setLive] = React.useState(null)
      var [error, setError] = React.useState(null)
      var [selectedIndex, setSelectedIndex] = React.useState(null)
      var [route, setRoute] = React.useState({ level: 'overview', key: null })
      var restoreFocusRef = React.useRef(null)

      React.useEffect(function () {
        var alive = true
        var source = null
        var timer = null

        function apply(payload) {
          if (!alive || payload === null || typeof payload !== 'object') return
          if (Array.isArray(payload.turns)) setTurns(payload.turns)
          setLive(payload.snapshot || null)
          setError(null)
        }

        function poll() {
          if (typeof fetch !== 'function') return
          fetch('/graph-chat/api/state?sessionId=' + encodeURIComponent(sessionId))
            .then(function (response) { return response.json() })
            .then(function (body) {
              if (!alive || body === null || typeof body !== 'object') return
              if (Array.isArray(body.turns)) setTurns(body.turns)
              setError(null)
            })
            .catch(function (failure) { if (alive) setError(String(failure)) })
        }

        setTurns([])
        setLive(null)
        setError(null)
        setSelectedIndex(null)
        setRoute({ level: 'overview', key: null })
        if (!sessionId) {
          return function () { alive = false }
        }

        if (typeof EventSource !== 'undefined') {
          try {
            source = new EventSource('/graph-chat/api/events?sessionId=' + encodeURIComponent(sessionId))
            source.addEventListener('graph', function (event) {
              try { apply(JSON.parse(event.data)) } catch (failure) { /* ignore malformed frame */ }
            })
            source.onopen = function () {
              if (timer !== null) {
                clearInterval(timer)
                timer = null
              }
              if (alive) setError(null)
            }
            source.onerror = function () {
              if (alive && timer === null) timer = setInterval(poll, 2000)
            }
          } catch (failure) {
            if (source) {
              try { source.close() } catch (error) { /* ignore */ }
            }
            source = null
          }
        }
        if (source === null) {
          poll()
          timer = setInterval(poll, 2000)
        }

        return function () {
          alive = false
          if (source) source.close()
          if (timer !== null) clearInterval(timer)
        }
      }, [sessionId])

      var model = overviewModel(turns, live)
      var itemCount = model.nodes.length

      React.useEffect(function () {
        if (itemCount === 0) return
        setSelectedIndex(function (previous) {
          if (previous === null || previous < 0 || previous >= itemCount) return itemCount - 1
          return previous
        })
      }, [itemCount])

      React.useEffect(function () {
        if (route.level !== 'turn' || itemCount === 0) return
        var found = false
        for (var i = 0; i < model.nodes.length; i++) {
          if (model.nodes[i].key === route.key) { found = true; break }
        }
        if (!found) setRoute({ level: 'turn', key: model.nodes[model.nodes.length - 1].key })
      }, [route, itemCount, model.signature])

      React.useEffect(function () {
        if (route.level !== 'overview' || restoreFocusRef.current === null) return
        var key = restoreFocusRef.current
        restoreFocusRef.current = null
        if (typeof document === 'undefined') return
        var element = document.getElementById('dshgv-ov-' + key)
        if (element && element.focus) element.focus()
      }, [route.level, model.signature])

      var detailItem = null
      if (route.level === 'turn' && itemCount > 0) {
        for (var i = 0; i < model.nodes.length; i++) {
          if (model.nodes[i].key === route.key) { detailItem = model.nodes[i]; break }
        }
        if (detailItem === null) detailItem = model.nodes[model.nodes.length - 1]
      }
      var selectedNode = selectedIndex !== null && selectedIndex >= 0 && selectedIndex < itemCount
        ? model.nodes[selectedIndex]
        : itemCount > 0 ? model.nodes[itemCount - 1] : null

      function drill(item) {
        setSelectedIndex(item.index)
        setRoute({ level: 'turn', key: item.key })
      }

      function back() {
        if (detailItem !== null) restoreFocusRef.current = detailItem.key
        setRoute({ level: 'overview', key: null })
      }

      function onRootKeyDown(event) {
        if (event.key !== 'Escape') return
        if (route.level === 'turn') {
          event.preventDefault()
          back()
        }
      }

      var content
      if (itemCount === 0) {
        content = h('div', { className: 'dshgv-view' },
          h('div', { className: 'dshgv-bar' },
            h('span', { className: 'dshgv-title' }, h('b', null, tr('allTurns') + ' \u00B7 0')),
            h('span', { className: 'dshgv-session', title: sessionId || undefined }, sessionId || tr('noSession'))
          ),
          h('div', { className: 'dshgv-empty' },
            h('svg', {
              className: 'dshgv-empty-icon',
              width: 48,
              height: 48,
              viewBox: '0 0 48 48',
              'aria-hidden': 'true'
            },
              h('g', { stroke: C.border, strokeWidth: 1.2, fill: C.surface },
                h('line', { x1: 13, y1: 31, x2: 23, y2: 16 }),
                h('line', { x1: 23, y1: 16, x2: 35, y2: 28 }),
                h('line', { x1: 13, y1: 31, x2: 30, y2: 37 }),
                h('circle', { cx: 13, cy: 31, r: 4 }),
                h('circle', { cx: 23, cy: 16, r: 5 }),
                h('circle', { cx: 35, cy: 28, r: 3.5 }),
                h('circle', { cx: 30, cy: 37, r: 3 })
              )
            ),
            error !== null
              ? h('p', { className: 'dshgv-error', role: 'alert' }, error)
              : h('p', null, tr('empty'))
          )
        )
      } else if (route.level === 'turn' && detailItem !== null) {
        content = h(TurnDetail, {
          item: detailItem,
          tr: tr,
          openView: props.openView,
          onBack: back
        })
      } else {
        content = h(Overview, {
          model: model,
          tr: tr,
          selectedKey: selectedNode === null ? null : selectedNode.key,
          onDrill: drill,
          live: model.nodes.some(function (node) { return node.live })
        })
      }

      return h('div', { className: 'dshgv', onKeyDown: onRootKeyDown }, content)
    }

    function apply(ctx) {
      injectStyle()
      ctx.effect(function () {
        return ctx.locale.register(NS, { en: EN, zh: ZH })
      }, 'graph-view:locale')
      var t = ctx.locale.bind(NS)
      ctx.effect(function () {
        return ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register({
            name: 'conversation.view',
            id: 'graph',
            order: 5,
            locale: NS,
            label: function () { return t('view') }
          }, GraphBody)
        })
      }, 'graph-view:tab')
    }

    exports.name = 'explore-graph-view'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    exports.GraphBody = GraphBody
    return module.exports
  }
})
