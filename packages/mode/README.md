# dsh-graph-loop-mode

> **Active mode in 0.2.** This bundle registers the **Explore** agent preset and sets
> `agent-preset-registry.default = explore`, so new sessions use it after
> `scripts/install-explore.sh`. It is a preset (tool/persona composition), not a loop replacement;
> the graph driver comes from `dsh-graph-loop`. The duplicate-spawn guard **blocks** by default;
> `suggest_executor` is the advisory half.

The Explore mode: an agent preset plus the small pieces that make graph-style collaboration cheaper
without owning the loop. The driver comes from `dsh-graph-loop`.

## Contents

- `policy` row: a system-prompt section with the routing policy and the reuse/spawn rule. It names a
  node of its own `inspect → plan → act → verify` cycle only when the host graph driver is **not**
  mounted. When `graphRuntime` is present the loop already injects `[graph node <plan node>]` per
  step, so the preset omits its node line and the model sees one node narrative.
- `tools` row: `suggest_executor` plus a `spawn_teammate` guard that denies a spawn a reusable idle
  teammate already covers. This row deliberately registers no `graph_status`: `dsh-graph-loop` owns
  that host-wide tool and reports the live plan/run. Scoped tools shadow host tools, so a preset copy
  would hide the real one.
- `reuse`: roster projection and idle-teammate matching helpers (pure functions, no DSH imports).

## Configuration

The preset is composed by `cordis.patch.yml`; tune the graph policy text through the preset document
rather than editing the plugin. The `explore-tools` row accepts:

| key | default | effect |
| --- | --- | --- |
| `blockDuplicateSpawn` | `true` | Deny a `spawn_teammate` call that duplicates an idle teammate. Set `false` to restore unguarded delegation without removing the row. |
| `reuseThreshold` | `0.5` | Minimum combined score for the guard and for a `reuse` recommendation. Even below it, a denial also requires the text-only floor described below. |
| `suggestThreshold` | `0.34` | Minimum score for `suggest_executor` to list a candidate. |

The guard is **blocking**: a `spawn_teammate` call is denied when an idle teammate covers at least
half of the task's *distinctive* tokens (`GUARD_TEXT_FLOOR = 0.5`) **and** scores at least
`reuseThreshold`. Matching drops stopwords and generic intent words (`fix`, `bug`, `test`, `api`,
`docs`, …), folds simple suffixes (`tests`/`testing`/`tested` → `test`, `bugs` → `bug`), and ignores
one-word tasks. The idle-status bonus can rank candidates but cannot deny a spawn on its own.

## Extension points

- Add the bundle with `dsh plugin --profile web add dsh-graph-loop-mode`.
- The guard is a tool wrapper; remove the row to restore unguarded delegation, or set
  `blockDuplicateSpawn: false` to keep `suggest_executor` without the denial.

## Model Experience

The policy section and guard message are model-visible and logged through the normal system-prompt
and tool-result paths. A duplicate spawn is refused with the matching teammate's name and a
send_message remediation hint, so a turn can avoid the spawn entirely. `graph_status` comes from the
graph driver, not from this mode.

## Known Limitations and Deferred Work

- Reuse is a lexical/heuristic match over the roster, not a measured utility model; the stoplist and
  suffix folding are English-oriented, and CJK text is compared as character bigrams.
- The text-only floor is a fixed constant, not a configurable knob; raising `reuseThreshold` only
  makes the guard stricter.
- The bundle's preset duplicates the standard preset rows; preset drift must be merged manually.
