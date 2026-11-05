/**
 * templates.ts — the shipped template library for the `explore` preset.
 *
 * A template is the routing menu entry: it declares which task classes it
 * applies to (`appliesTo`), which tools must be present and visible
 * (`toolUniverse`), the slots the matcher binds to real tools, a bounded
 * budget, and the gate policy. The matcher (`matching.ts`) hard-filters,
 * instantiates and scores these; `t_stock` is the always-available fallback
 * and the in-process A/B control arm (a single self-contained step, no slots).
 *
 * Slot names matter: `synthesizeNodes()` orders slots alphabetically, so every
 * template below names its slots in intended execution order. Instructions are
 * kept short (< 200 chars): they are appended as a user message per node.
 *
 * Tool names are the real model-facing names from the DSH tool catalog
 * (docs/tool-catalog.md); the curated artifact facts live in `registry.ts`.
 */

import type { IntentClass, SlotSpec, TaskTemplate, TemplateLibrary } from './matching.ts'

/** Fallback template id; `match()` resolves it from the library by id. */
export const FALLBACK_TEMPLATE_ID = 't_stock'

const ALL_INTENTS: readonly IntentClass[] = [
  'code-question',
  'code-review',
  'code-change',
  'bug-fix',
  'test-failure',
  'research',
  'fact-finding',
  'document',
  'data-analysis',
  'wide-research',
  'multi-area-review',
  'other',
]

const slot = (choose: readonly string[], scoreBy: SlotSpec['scoreBy']): SlotSpec => ({ choose, scoreBy })

/**
 * The six shipped templates. Order is the deterministic candidate order used by
 * `match()` before scoring; keep `t_stock` last so an A/B control arm never
 * disappears because a deployment trims the list from the end.
 */
export const TEMPLATE_LIBRARY_TEMPLATES: readonly TaskTemplate[] = [
  {
    id: 't_investigate',
    label: 'read-only codebase investigation',
    appliesTo: { intent: ['code-question', 'code-review'], artifactsIn: ['path.locator'], mutating: false },
    toolUniverse: ['glob', 'grep', 'read'],
    risk: 0.15,
    gatePolicy: 'cold',
    slots: {
      discover: slot(['glob', 'grep'], 'artifactMatch'),
      inspect: slot(['read'], 'artifactMatch'),
    },
    budget: { maxNodes: 4, maxSteps: 8, maxTokens: 80_000, maxWallMs: 300_000, maxReplans: 1 },
  },
  {
    id: 't_edit_test',
    label: 'investigate, patch and verify a code change',
    appliesTo: { intent: ['code-change', 'bug-fix'], artifactsIn: ['path.locator'], mutating: true },
    toolUniverse: ['read', 'grep', 'glob', 'edit', 'write', 'bash'],
    risk: 0.6,
    gatePolicy: 'cold',
    slots: {
      discover: slot(['grep', 'glob', 'read'], 'artifactMatch'),
      patch: slot(['edit', 'write'], 'successRate'),
      test: slot(['bash'], 'artifactMatch'),
    },
    budget: { maxNodes: 5, maxSteps: 12, maxTokens: 150_000, maxWallMs: 600_000, maxReplans: 2 },
  },
  {
    id: 't_bugfix',
    label: 'reproduce, repair and re-test a failure',
    appliesTo: { intent: ['bug-fix', 'test-failure'], artifactsIn: ['path.locator'], mutating: true },
    toolUniverse: ['read', 'grep', 'bash', 'edit', 'write'],
    risk: 0.55,
    gatePolicy: 'cold',
    slots: {
      confirm: slot(['bash', 'read'], 'successRate'),
      repair: slot(['edit', 'write'], 'artifactMatch'),
      test: slot(['bash'], 'artifactMatch'),
    },
    budget: { maxNodes: 5, maxSteps: 12, maxTokens: 150_000, maxWallMs: 600_000, maxReplans: 2 },
  },
  {
    id: 't_research',
    label: 'web research and cited answer',
    appliesTo: { intent: ['research', 'fact-finding'], artifactsOut: ['web.page'], mutating: false },
    toolUniverse: ['web_search', 'web_fetch', 'read', 'write', 'present'],
    risk: 0.2,
    gatePolicy: 'cold',
    slots: {
      gather: slot(['web_search'], 'artifactMatch'),
      read: slot(['web_fetch', 'read'], 'artifactMatch'),
      report: slot(['write', 'present'], 'intentMatch'),
    },
    budget: { maxNodes: 5, maxSteps: 10, maxTokens: 120_000, maxWallMs: 480_000, maxReplans: 1 },
  },
  {
    id: 't_doc',
    label: 'document drafting and delivery',
    appliesTo: { intent: ['document'], artifactsOut: ['file.text'], mutating: true },
    toolUniverse: ['read', 'write', 'present'],
    risk: 0.3,
    gatePolicy: 'cold',
    slots: {
      gather: slot(['read'], 'artifactMatch'),
      produce: slot(['write'], 'successRate'),
      send: slot(['present'], 'intentMatch'),
    },
    budget: { maxNodes: 5, maxSteps: 8, maxTokens: 100_000, maxWallMs: 420_000, maxReplans: 1 },
  },
  {
    id: FALLBACK_TEMPLATE_ID,
    label: 'single-pass stock-equivalent fallback',
    appliesTo: { intent: ALL_INTENTS },
    toolUniverse: [
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'bash',
      'todo_write',
      'present',
      'skill',
      'ask_user_question',
      'web_search',
      'web_fetch',
      'subagent',
      'workflow',
    ],
    risk: 0.5,
    gatePolicy: 'cold',
    slots: {},
    fixedNodes: [
      {
        id: 'n_step',
        kind: 'agent-step',
        executor: 'step',
        instruction: 'Work directly on the task with the available tools; this is the conservative fallback path.',
      },
      {
        id: 'n_end',
        kind: 'terminal',
        executor: 'step',
      },
    ],
    fixedEdges: [{ from: 'n_step', to: 'n_end', kind: 'control', when: { op: 'always' } }],
    budget: { maxNodes: 2, maxSteps: 40, maxTokens: 400_000, maxWallMs: 1_800_000, maxReplans: 2 },
  },
]

/** The shipped, versioned template library consumed by `match()`. */
export const TEMPLATE_LIBRARY: TemplateLibrary = {
  version: 1,
  templates: TEMPLATE_LIBRARY_TEMPLATES,
  fallbackId: FALLBACK_TEMPLATE_ID,
}

/** Look up one template by id (returns undefined for unknown ids). */
export function templateById(id: string): TaskTemplate | undefined {
  return TEMPLATE_LIBRARY.templates.find((template) => template.id === id)
}
