# dsh-graph-loop-ui

Web surface for the graph loop: the **Graph** tab in the existing conversation view
(`Chat | Graph | Trajectory`) and the standalone `/graph-chat` page/API used by tests and headless
clients. The tab reuses the existing Chat shell — composer, model selector, voice, mode badge,
agent team, subagent list and Trajectory are untouched; only the view body is new.

## Use this package

Installed as its own bundle layer (`dsh.bundle.patch`), so a headless profile that installs only the
driver never waits for `webServer`:

```sh
dsh plugin --profile web add dsh-graph-loop-ui
dsh plugin --profile web add dsh-graph-loop
```

From a checkout, `bash scripts/install-explore.sh web` installs both.

## Configuration

The `graph-chat` row accepts `path`, `provider`, `model`, `preset` and `cwd`. `provider`/`model` are
the fallback route for a fresh profile with no live root agent to inherit one from; `preset` is the
agent preset recorded on a new graph-chat session (absent means the profile default, Explore when
the mode bundle is installed); `cwd` is the working directory recorded on that session. The single
`graph-ui` row mounts both the `/graph-chat` host surface and the client bundle, and its patch
deliberately sets no `preset`.

## Extension points

- `conversation.view` slot entry `graph` (order 5), registered by the client bundle.
- `GET /graph-chat/api/state`, `/api/messages`, `/api/events` (SSE); `POST /api/new`, `/api/send`.
- The tab reads the same HTTP surface as the standalone page.

## Model Experience

The client half is not model-visible. The `/graph-chat/api/send` route submits an ordinary
`user/message` through `agent.followup()`, exactly like the Chat composer.

## Known Limitations and Deferred Work

- Node details show tool names/status and link to Trajectory; tool arguments and result bodies are
  not shown yet.
- The Graph tab follows the latest live snapshot; completed turns are read from the in-memory trace,
  so a Host restart keeps no graph history (session history is unaffected).
- `/graph-chat` adds no authentication of its own; it relies on the host Web server's trust fence when
  that service is mounted, so expose it only on a trusted origin.
- The browser bundle is hand-authored in the closure-factory envelope rather than emitted by the
  tsdown client preset; it has no authored source map or package-asset pipeline.
