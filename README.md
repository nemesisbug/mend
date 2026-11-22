# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nemesisbug/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nemesisbug/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** — one patch tool for every AI edit format, built for the [make.fun "Build mend" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

Agent harnesses apply edits that models write, and models write them in four formats. mend reads all four to one written contract (`SPEC.md` in the kit): unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. It finds the lines an edit names even when the model drifted their whitespace or indentation, and it changes every file or none.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory. When absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Matching

An edit names old lines that mend finds at the first of three tiers at which they occur at least once:

- **tier 0** — every line equal;
- **tier 1** — every line equal once trailing spaces and tabs are removed;
- **tier 2** — every line equal once leading and trailing spaces and tabs are removed, with new lines re-indented from the patch's indentation to the file's.

Context lines are always written as the file's own matched lines, never the patch's.

## Exit codes and output

- **Exit 2**, one line, nothing written: `error: usage`, `error: no-patch`, `error: format`, or `error: parse <N>`.
- **Exit 1**, nothing written: one `error: <code> <path>` line per failed edit (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then `failed: <k> of <n> edits`. Edits after a failure still run, so every failure is reported — but when any edit failed, no file is written.
- **Exit 0**: one line per changed path (`A <path>`, `D <path>`, `M <path>`, `R <old> -> <new>` for a move), in byte order, then `ok: <n> files` (`ok: 1 file` when n is 1). A patch that changes nothing prints only `ok: 0 files`.

## Layout

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner, kept as issued; when `MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it.

## Practice

The kit's practice set (100 checks: 30 unified, 20 SEARCH/REPLACE, 20 V4A, 15 JSON, 15 command line) passes clean, verified twice with identical results:

```sh
node check.ts ../program/generator/practice.json
# 100 of 100 passed: practice score 1000
```

The edge over the house's strict applier is exactly what the score measures: correct tier 1/2 matching and re-indentation on drifted whitespace, nearest-occurrence hunk placement on wrong line numbers, and the V4A anchor/cursor walk.

## License

MIT — see `LICENSE`.
