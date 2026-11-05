# @dsh/explore-mode

Bundle A: an `explore` agent preset over the stock loop, plus the small pieces that make graph-style
collaboration cheaper without replacing the driver.

## Contents

- `policy` row: a system-prompt section describing the capability graph and when to propose one.
- `tools` row: `suggest_executor` and `graph_status` for the preset, plus a `spawn_teammate` guard that
  points the model at the roster before creating a new teammate.
- `reuse`: roster projection and idle-teammate matching helpers.

## Configuration

The preset is composed by `cordis.patch.yml`; tune the graph policy text through the preset document
rather than editing the plugin.

## Extension points

- Add the bundle with `dsh plugin --profile web add <path-to-packages/mode>`.
- The guard is a tool wrapper; remove the row to restore unguarded delegation.

## Model Experience

The policy section and guard message are model-visible and logged through the normal system-prompt
and tool-result paths. The guard prefers reuse, so a turn may avoid a spawn entirely.

## Known Limitations and Deferred Work

- Reuse is a lexical/heuristic match over the roster, not a measured utility model.
- The bundle's preset duplicates the standard preset rows; preset drift must be merged manually.
