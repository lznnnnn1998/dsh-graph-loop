# Marketplace submission (awesome-dsh-plugin)

Prepared entries for
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
The upstream PR adds these two files only (monorepo subpackages):

- `lznnnnn1998__dsh-graph-loop--packages-loop.yml`
- `lznnnnn1998__dsh-graph-loop--packages-graph-ui.yml`

## Blockers at preparation time (2026-11-05)

1. The provided GitHub token can write `lznnnnn1998/dsh-graph-loop` but **cannot push the existing
   fork** `lznnnnn1998/awesome-dsh-plugin` (HTTP 403) and cannot create a fork via the API.
   Needed: a token with **Contents: Read and write** on `lznnnnn1998/awesome-dsh-plugin`
   (or a classic token with `public_repo`).
2. `PUT /repos/lznnnnn1998/dsh-graph-loop/topics` is denied, so the required `dsh-plugin`
   topic must be added manually (GitHub → repo → About → Topics).
3. The repository was created 2026-11-05T16:31:21Z. The marketplace requires a repo at least one day
   old, so the earliest submission that can pass CI is **2026-11-06T16:31:21Z** (00:31 +08:00).

## Finish when unblocked

```sh
# fork already exists: lznnnnn1998/awesome-dsh-plugin
git clone https://github.com/lznnnnn1998/awesome-dsh-plugin.git /tmp/awesome-fork/repo
cd /tmp/awesome-fork/repo
git remote add upstream https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.git
git fetch upstream main
git checkout -b add-dsh-graph-loop upstream/main
mkdir -p data/plugins
cp /path/to/dsh-graph-loop/marketplace/lznnnnn1998__dsh-graph-loop--packages-*.yml data/plugins/
git add data/plugins/lznnnnn1998__dsh-graph-loop--packages-*.yml
git commit -m 'Add dsh-graph-loop (driver + Graph tab)'
git push origin add-dsh-graph-loop
```

Then open:
`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...lznnnnn1998:add-dsh-graph-loop?expand=1`
