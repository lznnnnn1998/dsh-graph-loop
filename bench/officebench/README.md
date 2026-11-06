# OfficeBench probe

External benchmark: [OfficeBench](https://github.com/zlwang-cs/OfficeBench) (Apache-2.0, not vendored
in this repo). The 5-task probe manifest is [`probe-tasks.json`](probe-tasks.json); the evaluation
protocol is [`docs/EVALUATION.md`](../../docs/EVALUATION.md).

## Pinned version

```
repo:   https://github.com/zlwang-cs/OfficeBench
commit: b978b808667c32b52ce19a67ce1def1de9ae02b7
date:   2026-03-31
```

Do not compare runs from different commits. Record the commit and container digest with every result.

## Preflight

```sh
OFFICEBENCH_DIR=/path/to/OfficeBench bash scripts/officebench-preflight.sh
```

The script checks the Docker daemon, the pinned commit, the evaluator and the five task files. It
exits non-zero with a `NOT READY` line when anything is missing; it never runs the benchmark.

## Setup (office machine)

```sh
git clone https://github.com/zlwang-cs/OfficeBench.git
cd OfficeBench
git checkout b978b808667c32b52ce19a67ce1def1de9ae02b7
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# OfficeBench's Dockerfile copies this file at build time; create it even if the
# probe uses a local model endpoint.
touch openai_key.txt
docker build -f docker/Dockerfile -t officebench .
```

The DSH side needs an adapter from OfficeBench actions to DSH tools (or a file-level
reimplementation for the five tasks). That adapter is M3/M4 work; the probe is not runnable until it
exists.

## Probe tasks

| id | subtask | app | artifact | what it checks |
|---|---|---|---|---|
| 1-15 | 0 | word | docx | append a sentence to an existing document |
| 1-16 | 0 | word | docx | create a document from a text file |
| 1-9 | 0 | excel | xlsx | write a computed row into a sheet |
| 1-11 | 0 | excel | xlsx | sort and save a new workbook |
| 1-19 | 0 | pdf | docx | extract metadata from a PDF into a document |

OfficeBench has **no PowerPoint app**; the probe uses Word, Excel and PDF. This is deliberate and
recorded so the plan never claims PowerPoint coverage it does not have.

## Arms

`official` (DSH default profile), `stock` (same model/tools/max_iter), `composition` (this bundle).
All three arms use the same container image, task files, model and seed.

## Pass criteria

All three arms complete all five tasks, and the evaluator returns a score for all fifteen task-runs.
The probe does **not** require composition to win; it only proves the comparison is measurable.

After the probe: **continue / change benchmark / stop**. This is the first hard decision gate.

## Status

Protocol and task selection are defined. The probe has not been run in this workspace: there is no
Docker daemon and no OfficeBench checkout on the development machine at the time of writing.
