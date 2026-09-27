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

```
any-branch  →  main  →  (automatic) Cut Release  →  vX.Y.Z tag  →  release.yml
```

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
no Electron launch or real model download required to run it.

## Code of conduct / security

See [`SECURITY.md`](SECURITY.md) for reporting vulnerabilities. Be
respectful in issues and pull requests — this is a small, actively
maintained project.
