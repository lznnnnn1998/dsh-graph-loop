# @dsh/explore-graph-ui

Web surface for the graph loop: the **Graph** tab in the existing conversation view
(`Chat | Graph | Trajectory`) and the standalone `/graph-chat` page/API used by tests and headless
clients. The tab reuses the existing Chat shell — composer, model selector, voice, mode badge,
agent team, subagent list and Trajectory are untouched; only the view body is new.

## Use this package

Installed as its own bundle layer (`dsh.bundle.patch`), so a headless profile that installs only the
driver never waits for `webServer`:

```sh
dsh plugin --profile web add <path-to-packages/graph-ui>
```

## Configuration

The `graph-chat` row accepts `path`, `provider`, `model` and `preset` (used when a fresh profile has
no live root agent to inherit a route from). The `graph-ui` row is a no-op host carrier for the
browser bundle.

## Extension points

- `conversation.view` slot entry `graph` (order 5), registered by the client bundle.
- `GET /graph-chat/api/state`, `/api/messages`, `/api/events` (SSE); `POST /api/new`, `/api/send`.
- The tab reads only the HTTP surface, so it can be developed without a client rebuild.

## Model Experience

The client half is not model-visible. The `/graph-chat/api/send` route submits an ordinary
`user/message` through `agent.followup()`, exactly like the Chat composer.

## Known Limitations and Deferred Work

- Node details show tool names/status and link to Trajectory; tool arguments and result bodies are
  not shown yet.
- The Graph tab follows the latest live snapshot; completed turns are read from the in-memory trace,
  so a Host restart keeps no graph history (session history is unaffected).
- `/graph-chat` has no extra authentication; expose it only on a trusted local origin.
- The browser bundle is hand-authored in the closure-factory envelope rather than emitted by the
  tsdown client preset; it has no authored source map or package-asset pipeline.
