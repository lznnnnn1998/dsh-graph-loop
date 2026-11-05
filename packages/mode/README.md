# @dsh/explore-mode

Bundle A of the explore work: a fifth **agent mode** for the Web UI, installed into an
existing profile. It is a per-session preset, not a loop replacement — the host keeps the
stock `agent-loop`, so session events, projections, approvals, cancellation, compaction and
resume behave exactly as before.

## What it installs

One `@deepseek-ai/dsh-agent-preset` row (`preset-explore`, `order: 5`) whose child rows are
the shipped `standard` preset's list with two edits:

- the `delegation` group (subagent tools + `workflow`) is removed — this mode delegates
  through the shared Agent Teams roster instead of ad-hoc subagents;
- `explore-policy` and `explore-tools` are appended.

Child ids match `standard`, so a Web preset-editor override written for standard still
applies here. `tool-agent-team` is not added: it is a host row supplied by the agent-team
profile bundle, and a preset must never provide services (activation auditing rejects
globally leaked services).

## Plugins

| module | what it does |
|---|---|
| `./src/policy.ts` | agent-scoped prompt **section** `explore:policy` (node directive from the configured cycle, advancing per step) and prompt **context** `explore:roster` (idle Agent Teams teammates, one line each, omitted when empty or when the service is absent) |
| `./src/tools.ts` | tools `suggest_executor` and `graph_status`, plus a `tools/pre-execute` guard on `spawn_teammate` |
| `./src/reuse.ts` | pure scoring: `normalize`, `tokenOverlap`, `scoreExecutor`, `rankCandidates`, `shouldSuggestReuse`, `duplicateSpawnDecision` — no DSH imports, unit-tested |

## The duplicate-spawn guard

Denies `spawn_teammate` only when **all** of these hold:

1. `blockDuplicateSpawn` is true (default);
2. the call is `spawn_teammate` and carries a live Agent;
3. the Agent Teams service is mounted and returns a roster;
4. the proposed `description` yields at least two tokens;
5. an **idle** (`status: inactive`, non-lead) teammate scores `>= reuseThreshold` (default 0.5),
   where `score = 0.75 * containment(taskTokens, name+description) + 0.25 * status`.

Any error inside the guard falls through to the next listener — it never throws and never
denies an unrelated tool. Denial text names the matching teammates and tells the model to
reuse them via `send_message` or to describe a genuinely different responsibility.

**Risk:** the guard is heuristic. A terse, generic description ("fix the tests") can overlap
an idle teammate enough to be denied even when a new agent is justified. Mitigations: the
threshold is configurable, `blockDuplicateSpawn: false` disables it per deployment, the
`description`-only signal keeps false positives low, and the remediation text always
explains the alternative.

## Config

```yaml
- id: explore-policy
  name: '@dsh/explore-mode/policy'
  config:
    nodes: [inspect, plan, act, verify]   # optional
    rosterContext: true                   # optional
- id: explore-tools
  name: '@dsh/explore-mode/tools'
  config:
    blockDuplicateSpawn: true             # guard on by default
    suggestThreshold: 0.34
    reuseThreshold: 0.5
    nodes: [inspect, plan, act, verify]
```

## Install (throwaway profile shown; the same works for `--profile web`)

```sh
cd /Users/zhinan/deepseek-harness
DSH_HOME=/tmp/dsh-explore-a node --import tsx/esm apps/cli/src/bin.ts \
  --profile explore --from-default-profile web --dump-config >/dev/null
DSH_HOME=/tmp/dsh-explore-a node --import tsx/esm apps/cli/src/bin.ts \
  plugin --profile explore add /Users/zhinan/Documents/dsh_workspace/dsh-graph-loop/packages/mode
DSH_HOME=/tmp/dsh-explore-a node --import tsx/esm apps/cli/src/bin.ts \
  --profile explore --dump-config | grep -n "preset-explore"
```

`--from-default-profile` and `plugin` cannot be combined in one invocation: `--from-default-profile`
is not a pnpm option, so create the profile first, then install.

## Verify

```sh
cd /Users/zhinan/Documents/dsh_workspace/dsh-graph-loop
node --import tsx --test test/unit/mode-reuse.test.ts
NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.json --noEmit
```

The 8 GB heap is required by the shared workspace's DSH type graph, not by this package.
