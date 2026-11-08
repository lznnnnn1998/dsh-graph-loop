# product20 partial run — 2026-11-08

**Invalid as a product aggregate; the instrument is unvalidated for the full suite.** 19 of 20 tasks
were attempted; `formal-crypto` has no verifier image. Raw rows: [`rows.jsonl`](rows.jsonl); counts:
[`summary.json`](summary.json). No accuracy, parity, token or cost number from this run is citable.

## What the rows say

- **11 graph** and **3 stock** trials produced a valid score (`n_trials: 1`); every one is **0.0**.
- Only **2 tasks** (`bun-sourcemap-leak`, `cargo-flight-dispatch`) are paired-valid, both **0.0/0.0**.
- The other 24 rows have `n_trials: 0` — an infrastructure error, **not** an agent score.

| Task | graph score (n) | stock score (n) | graph failure | stock failure |
|---|---|---|---|---|
| bun-sourcemap-leak | 0.0 (1) | 0.0 (1) | none | none |
| cargo-flight-dispatch | 0.0 (1) | 0.0 (1) | artifact not written | none |
| foodstuff-beta-activity | 0.0 (1) | err (0) | artifact not written | timeout 900 s |
| freight-dispatch-shift | err (0) | err (0) | old Node (`node:sqlite`) | old Node (`node:sqlite`) |
| heat-pump-warranty | err (0) | 0.0 (1) | missing image + TLS | artifact `cp` failed |
| html-js-filter | 0.0 (1) | err (0) | artifact not written | timeout 900 s |
| interleaved-vigenere | 0.0 (1) | err (0) | artifact not written | timeout 900 s |
| intrastat-meldung | err (0) | err (0) | npm connect timeout | timeout 900 s |
| legacy-utility-triage | err (0) | err (0) | timeout 1800 s | timeout 900 s |
| medical-claims-processing | err (0) | err (0) | MCP unsupported | MCP unsupported |
| music-harmony | 0.0 (1) | err (0) | artifact not written | timeout 900 s |
| nextjs-performance | 0.0 (1) | err (0) | none | timeout 900 s |
| photonic-waveguide-routing | err (0) | err (0) | timeout 900 s | timeout 900 s |
| pretrain-shard-corruption | 0.0 (1) | err (0) | artifact not written | timeout 900 s |
| protein-autointerp-disulfide | 0.0 (1) | err (0) | none | timeout 900 s |
| risk-scorer-replay | 0.0 (1) | err (0) | artifact not written | timeout 900 s |
| roy-polymorph-cn | 0.0 (1) | err (0) | artifact not written | timeout 900 s |
| shadow-relay | err (0) | err (0) | Docker CPU cap (4) | Docker CPU cap (4) |
| vpp-loss-divergence | err (0) | err (0) | reward file missing | timeout 900 s |

"Artifact not written" is Harbor's best-effort download of a file the agent never produced; those
trials still reached the verifier and scored 0.0 (except `freight`, where DSH never started).

## Error taxonomy (job.log evidence)

38 Harbor job logs survive under `/tmp/product20-shard*/jobs/`. Counts are job logs, not stored
trials:

| Class | Job logs | Tasks | Evidence |
|---|---|---|---|
| `Command timed out after 900 seconds` | 14 (13 stock, 1 graph) | foodstuff, html, interleaved, intrastat, legacy, music, nextjs, photonic (both), pretrain, protein, risk, roy, vpp | fixed runner timeout (pre-HEAD policy) |
| `Command timed out after 1800 seconds` | 1 | legacy-utility-triage graph | longer command/setup budget |
| `range of CPUs is from 0.01 to 4.00` | 2 | shadow-relay (both arms) | compose CPU request > Colima's 4-CPU VM |
| `No such image: harborframework/terminal-bench:…` + `TLS handshake timeout` to `registry-1.docker.io` | 1 | heat-pump-warranty graph | sidecar image never pulled/built |
| `does not support MCP servers; … capabilities.mcp_servers = True` | 2 | medical-claims-processing (both) | **real adapter gap** |
| `UND_ERR_CONNECT_TIMEOUT` to `registry.npmjs.org` | 1 | intrastat-meldung graph | in-container bootstrap network |
| `RewardFileNotFoundError is in exclude_exceptions` | 1 | vpp-loss-divergence graph | verifier/reward artifact missing |
| `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite` | 2 | freight-dispatch-shift (both) | image has Node 20.19.2; DSH needs Node ≥ 22.5; the adapter only checks that `node` exists, so it never upgrades |

### Correction: the amd64/qemu claim is not supported

The previous version of this README said sidecar tasks "ran amd64 images under qemu". A search of
all 38 job logs for `exec format error`, `qemu` and `linux/amd64` returns **zero hits**. The sidecar
failures above are missing images, a CPU cap and an old Node — not qemu. The next compose run also
uses the arm64 env tag for the `main` service (`build-arm64-task.sh`); sidecars remain vendor images.

## Provenance the rows do not carry

These rows predate the row schema. They record only `task, arm, score, n_trials, n_errors, exit,
result`. Known and not known:

- model: `deepseek/deepseek-flash` (from each job's `config.json`);
- agent setup timeout multiplier: 5;
- agent timeout: fixed 900 s (the runner exported `DSH_AGENT_TIMEOUT_SEC=900`; the adapter default
  was 1800);
- images: `tb-arm64-<task>-env:latest` / `tb-arm64-<task>-verifier:latest`;
- commit: **not recorded**. The run window (16:02–17:53) brackets HEAD `d80d3b1`; the worker did not
  capture `git rev-parse HEAD`, so no exact commit is asserted here;
- every `result` path points into `/tmp/product20-shard*/`, which is ephemeral. Do not backfill these
  fields with guesses; the current runner writes them and copies `result.json` under `raw/`.

## Conclusion

**No product claim.** The three-task oracle control (`2026-11-08-oracle-control/`) scores 1.0 on
`html-js-filter`, `cargo-flight-dispatch` and `music-harmony`, so the 0.0s are not a blanket harness
artifact; the loop's contribution is simply not measurable from this run. Fix MCP (implement or
exclude), the sidecar image/CPU blockers, old-Node images and the per-task timeout policy before
another full product20 run.
