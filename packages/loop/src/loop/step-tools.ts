/** Per-step tool admission and node-intent rules shared by the graph loop. */

import type { ResolvedToolSet, ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Tools whose successful call is the mutation the node exists to perform. */
const MUTATION_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch', 'multi_edit'])

/** Tools whose successful call inspects the workspace without changing it. */
const READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep'])

/** A stage word appears in the node id or its instruction. */
const MUTATION_STAGE = /(?:^|[_\s:/-])(?:mutate|mutation|edit|write|patch|apply)(?=$|[_\s:/-])/iu

/**
 * Shell commands that mutate the workspace.
 *
 * A redirect matches only at a command boundary (`> file`, `>> file`, `2> file`,
 * `2>> file`, `>| file`, `&> file`) so an arrow that is part of an argument —
 * Python's `print('a->b')`, a lambda, a `=>` — is not a write. Redirect detection
 * runs on the command with quoted spans removed (see `unquotedShell`): a `>` in
 * `python3 -c "x > 1"` is code, not a redirection. The redirect target must not
 * be `&` (descriptor duplication such as `2>&1`) or `/dev/null` (a deliberate
 * discard); both leave the workspace unchanged.
 */
const MUTATION_COMMAND = /(?:^|[\s;&|()])[0-9]?>>?\|?(?!\s*(?:&|\/dev\/null))|(?:^|[\s;&|()])(?:mv|rm|mkdir|cp|tee|truncate|dd)\s|sed\s+-i|perl\s+-pi/u

/** A writer opened from an interpreter one-liner (`open(path, 'w')`). */
const OPEN_WRITE = /open\([^)]*,\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?['"][wax]/u

/**
 * Shell commands that only read. `sed`/`awk` are readers only when the same
 * command is not a mutation, so callers AND this with `!mutationObserved(tool)`
 * and `sed -i` never counts as a read. The trailing guard rejects a longer word
 * (`category`, `findings`) that merely starts with a reader name. Like the
 * mutation regex, this runs on the unquoted command so a quoted `ls` in prose
 * is not a read.
 */
const READ_COMMAND = /(?:^|[\s;&|()])(?:cat|head|tail|grep|rg|awk|sed|ls|find|stat|diff)(?=$|[\s;&|()<>])/u

/** Shell-like tools whose command payload carries filesystem effects. */
const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh', 'run_code'])

/** Argument keys that carry a shell/script payload in the known tool schemas. */
const COMMAND_KEYS = ['command', 'cmd', 'script', 'code'] as const

/** True for the shipped shells, the PTC runner, and any configured shell name. */
function isShellTool(name: string, shellTools: ReadonlySet<string>): boolean {
  return SHELL_TOOL_NAMES.has(name) || shellTools.has(name)
}

/**
 * Remove single- and double-quoted spans from a shell command.
 *
 * Shell redirection and command words only have meaning outside quotes: a `>`
 * in `python3 -c "x > 1"` is a Python comparison, and `echo "cp x"` does not
 * copy a file. Stripping quotes before matching is the cheapest way to keep the
 * effect classifier from reading code or prose as a filesystem mutation. The
 * quotes themselves are removed too; a redirect whose target was quoted still
 * matches the redirect operator.
 * @param command - the shell command as recorded in tool arguments.
 * @returns the command with quoted spans removed.
 */
function unquotedShell(command: string): string {
  let out = ''
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string
    if (quote !== undefined) {
      if (char === quote && command[index - 1] !== '\\') quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    out += char
  }
  return out
}

/**
 * A shell wrapper that runs its quoted argument as a command (`bash -c "…"`,
 * `sh -lc '…'`, and the split-flag form `bash -e -c "…"`).
 */
const SHELL_WRAPPER = /\b(?:ba|z|da|k)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c[A-Za-z]*\s+(['"])([\s\S]*?)\1/gu

/**
 * Drop heredoc bodies before effect matching. A heredoc body is data (a commit
 * message, a config file, a test fixture), not shell: `git commit -F - <<'EOF'`
 * whose message contains `rm ` must not read as a deletion. The terminator is
 * the line equal to the word after `<<`/`<<-`, optionally quoted.
 * @param command - the shell command as recorded in tool arguments.
 * @returns the command with heredoc bodies removed.
 */
function stripHeredocs(command: string): string {
  if (!command.includes('\n')) return command
  const kept: string[] = []
  let terminator: string | undefined
  for (const line of command.split('\n')) {
    if (terminator !== undefined) {
      if (line.trim() === terminator) terminator = undefined
      continue
    }
    kept.push(line)
    const marker = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/u.exec(line)
    if (marker !== null) terminator = marker[2]
  }
  return kept.join('\n')
}

/**
 * The command text and any shell-wrapper payloads it contains.
 * @param command - the parsed shell command line.
 * @returns the outer command plus each `-c` argument, in encounter order.
 */
function shellPayloads(command: string): string[] {
  const clean = stripHeredocs(command)
  const payloads = [clean]
  for (const match of clean.matchAll(SHELL_WRAPPER)) {
    const payload = match[2]
    if (payload !== undefined && payload.length > 0) payloads.push(payload)
  }
  return payloads
}

/**
 * Whether a shell command line mutates the workspace.
 * @param command - the parsed `command`/`cmd`/`script` field.
 * @returns true for a real redirect or mutating command, including `open(...,'w')`.
 */
function mutatingCommand(command: string): boolean {
  return shellPayloads(command).some(payload =>
    MUTATION_COMMAND.test(unquotedShell(payload)) || OPEN_WRITE.test(payload))
}

/**
 * Recover the shell command a tool call actually runs.
 *
 * DSH tool arguments travel as a JSON string, so testing the raw `arguments`
 * would let JSON syntax (`":"`, `{"command":…}`) satisfy or defeat a shell
 * regex. Parse the JSON and prefer the `command`/`cmd`/`script` field, falling
 * back to the raw text for adapters and tests that pass the command directly.
 * @param raw - the call's `arguments` string as the session recorded it.
 * @returns the command text, or `''` when there is nothing to inspect.
 */
export function shellCommand(raw: string | undefined): string {
  if (raw === undefined) return ''
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of COMMAND_KEYS) {
        const value = (parsed as Record<string, unknown>)[key]
        if (typeof value === 'string') return value
      }
    }
  } catch {
    // Not JSON: a raw command string, used verbatim.
  }
  return raw
}

/**
 * Structural subset of `PlanNode` that decides whether a node must mutate.
 * Kept local so this module stays independent of the schema package.
 */
export interface NodeIntent {
  readonly id: string
  readonly kind?: string
  readonly capabilityId?: string
  readonly instruction?: string
  readonly toolAllow?: readonly string[]
}

/** One executed tool call as the loop records it for the node outcome. */
export interface StepTool {
  readonly name: string
  readonly isError: boolean
  readonly arguments?: string
}

/** Called once per admission when a non-empty plan universe admits no visible tool. */
export type EmptyAdmissionHandler = (visible: readonly string[]) => void

/**
 * Narrow the step's admitted tool set to the active node's tools.
 *
 * The plan already decided which capabilities are relevant; keeping the full
 * schema surface in every request would charge the graph for tools it cannot
 * use and would defeat the per-turn token win. An intersection that resolves to
 * nothing stays empty: widening back to the full preset would silently undo the
 * plan's narrowing (a stale plan is a routing bug to report, not to paper over).
 * A terminal node with an explicit empty `toolAllow` is answer-only, so its
 * empty admission is the intended result, not a resolution failure.
 *
 * @param base - the turn's resolved tool admission.
 * @param allowed - tool names the plan and node admit.
 * @param onEmpty - reports the visible set once when the intersection is empty.
 * @returns a view that exposes only `allowed` names, never the full preset.
 */
export function restrictToolSet(
  base: ResolvedToolSet,
  allowed: ReadonlySet<string>,
  onEmpty?: EmptyAdmissionHandler,
): ResolvedToolSet {
  let reported = false
  return {
    dispose: () => base.dispose(),
    view: (scope) => {
      const visible = base.view(scope)
      const filtered = new Map<string, ToolDefinition>()
      for (const [name, definition] of visible) {
        if (allowed.has(name)) filtered.set(name, definition)
      }
      if (filtered.size === 0 && visible.size > 0 && !reported) {
        reported = true
        onEmpty?.([...visible.keys()])
      }
      return filtered
    },
  }
}

/**
 * Whether the node's job is a mutation. Derived from the node itself rather
 * than a hardcoded id so the dynamic (`d_edit`) and composed (`n_mutate`)
 * synthesizers are treated alike:
 *
 * - a declared mutation capability (`tool:write`, `tool:edit`, ...),
 * - a mutation tool in the node's allowlist,
 * - a mutation stage word in the node id, or
 * - a shell node whose instruction asks for a change.
 *
 * A verification shell node (`d_verify`, `n_verify`) is deliberately not a
 * mutation: retrying it as one would tell the model not to run more checks.
 * @param node - the active plan node (structural subset).
 * @returns true when the node must produce a workspace mutation.
 */
export function isMutatingNode(node: NodeIntent): boolean {
  const capability = (node.capabilityId ?? '').toLowerCase()
  if (MUTATION_TOOLS.has(capability.slice(capability.lastIndexOf(':') + 1))) return true
  const tools = node.toolAllow ?? []
  if (tools.some(name => MUTATION_TOOLS.has(name))) return true
  if (MUTATION_STAGE.test(node.id)) return true
  return tools.some(name => SHELL_TOOL_NAMES.has(name)) && MUTATION_STAGE.test(node.instruction ?? '')
}

/**
 * Whether any successful tool call mutated the workspace.
 * @param tools - the step's recorded tool calls.
 * @param shellTools - configured shell tool names (a deployment may rename them).
 * @returns true when a writer tool ran, or a shell call contained a mutating command.
 */
export function mutationObserved(
  tools: readonly StepTool[],
  shellTools: ReadonlySet<string> = new Set(DEFAULT_SHELL_TOOLS),
): boolean {
  return tools.some(tool => !tool.isError && (
    MUTATION_TOOLS.has(tool.name)
    || (isShellTool(tool.name, shellTools) && mutatingCommand(shellCommand(tool.arguments)))
  ))
}

/**
 * Whether any successful tool call inspected the workspace.
 *
 * Read tools count on their own; a shell counts only when the same call is not a
 * mutation, so `sed -i` and `cat > file` are writes, never reads. This is the
 * single definition the graph's `readFile` fact and the benchmark retry share.
 * @param tools - the step's recorded tool calls.
 * @param shellTools - configured shell tool names.
 * @returns true when a reader tool ran, or a shell ran a reading command.
 */
export function readObserved(
  tools: readonly StepTool[],
  shellTools: ReadonlySet<string> = new Set(DEFAULT_SHELL_TOOLS),
): boolean {
  return tools.some((tool) => {
    if (tool.isError) return false
    if (READ_TOOLS.has(tool.name)) return true
    if (!isShellTool(tool.name, shellTools)) return false
    const command = shellCommand(tool.arguments)
    return !mutatingCommand(command)
      && shellPayloads(command).some(payload => READ_COMMAND.test(unquotedShell(payload)))
  })
}

/**
 * Verification tools whose lone failed call fails the step's graph node. The
 * pair is a default, not a hardcoded rule: a deployment with differently named
 * shells overrides it through `AgentLoop.Config.shellTools`.
 */
export const DEFAULT_SHELL_TOOLS: readonly string[] = ['bash', 'pwsh']

/**
 * The failed tool name when that error belongs to a configured verification
 * tool. A step that calls such a tool, gets an error, and then makes no other
 * tool call is a failed node even though every call was answered; any other
 * tool's error still lets the step succeed when it completed.
 * @param name - the failed call's tool name, from the step's `tool/call` event.
 * @param shellTools - configured verification tool names.
 * @returns the name to report as `failedTool`, or `undefined` when the tool is
 * not a configured verification tool.
 */
export function shellFailureTool(name: string | undefined, shellTools: ReadonlySet<string>): string | undefined {
  return name !== undefined && shellTools.has(name) ? name : undefined
}
