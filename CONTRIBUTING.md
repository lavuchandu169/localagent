# Contributing

## Branch strategy

One branch: **`main`**. Always releasable — every commit on it is
something that could be tagged and shipped. Protected: changes land via
pull request, and CI must pass before merging (0 required approvals, so a
solo maintainer isn't blocked waiting on a review — the status check is
the real gate).

All work — features, fixes, chores — happens on a short-lived branch off
`main` (any name), merged back into `main` via pull request. There's no
separate integration branch to promote through first.

**Releases cut themselves.** Every merge to `main` automatically bumps
`package.json`'s version, adds a `CHANGELOG.md` entry (from the merged
PR's own title — nothing to type), opens a version-bump PR, auto-merges
it once CI passes, pushes the matching `vX.Y.Z` tag, and starts
`.github/workflows/release.yml` (build and publish signed Mac/Windows
installers to a GitHub Release). No manual version bump, changelog edit,
or tag push required — see `.github/workflows/cut-release.yml`.

A non-`beta` bump (`patch`/`minor`/`major`, for whenever this project
eventually leaves beta) or a hand-written multi-line changelog entry can
still be triggered manually: Actions tab → Cut Release → Run workflow.

**This pipeline has a known-fragile step.** Opening the version-bump PR
pushes a branch and creates it using a dedicated `RELEASE_PR_TOKEN`
secret (a PAT, not the default `GITHUB_TOKEN`) specifically so that PR's
own CI run actually triggers — a GitHub platform quirk where
`GITHUB_TOKEN`-created pushes/PRs don't reliably trigger other workflows.
Even with that in place, the push has been denied outright on more than
one differently-scoped token, for a cause not yet root-caused. If Cut
Release fails at "Open the release PR and enable auto-merge", the
version bump can be cut by hand instead: run
`CHANGELOG_ENTRY="..." node scripts/bump-version.mjs beta`, build and
test, commit, push a branch, open a PR, merge once CI passes, then tag
the merge commit (`git tag vX.Y.Z <sha> && git push origin vX.Y.Z`) and
run `gh workflow run Release --ref vX.Y.Z` to start the real build.

```
any-branch  →  main  →  (automatic) Cut Release  →  vX.Y.Z tag  →  release.yml
```

## First-time setup

This repo vendors [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)
(the bundled free-tier provider) as a git submodule. A plain `git clone`
leaves `vendor/freellmapi/` empty — `npm run build` fails immediately
against an empty submodule otherwise, so run this once after cloning:

```bash
git submodule update --init --recursive
```

`scripts/verify-freellmapi-submodule.mjs` runs automatically as the first
step of `npm run build` and fails loudly with this exact command if the
submodule is missing, rather than failing confusingly deep inside
`scripts/build-freellmapi.mjs`.

## Workflow

1. Branch from `main`: `git checkout -b my-change main`
2. Make the change, with tests (`npm test` must pass locally).
3. Open a pull request into `main`. CI (`.github/workflows/ci.yml`) runs
   the build and full test suite automatically.
4. Merge once CI is green. That's it — the release is cut automatically
   from there.

## Commit messages

Prefix with the kind of change where it helps a reviewer skim the log:
`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`. Not strictly enforced,
but appreciated.

## Tests

```bash
npm run build
npm test
```

The suite is plain Node scripts against `MockProvider`/fake resolvers —
no Electron launch or real model download required to run it. Nothing in
`npm test` loads the real bundled FreeLLMAPI server or `better-sqlite3`
(every test against it uses a fake bundle), so this stays fast and
network-free.

**Trying the bundled free-tier provider itself under `npm run electron`**
is different: `better-sqlite3` needs Electron's native ABI, not plain
Node's, to actually load. Run `npm run rebuild:native` once before
`npm run electron` to try it — and `npm rebuild better-sqlite3` afterward
to switch back to plain Node (needed again before `npm test`/`node
dist/...`, which use plain Node's ABI).

## Code of conduct / security

See [`SECURITY.md`](SECURITY.md) for reporting vulnerabilities. Be
respectful in issues and pull requests — this is a small, actively
maintained project.
