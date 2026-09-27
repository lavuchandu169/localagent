# Contributing

## Branch strategy

- **`main`** — always releasable. Every commit on `main` is something that
  could be tagged and shipped. Protected: changes land via pull request,
  and the CI workflow must pass before merging.
- **`develop`** — integration/testing branch. New work lands here first,
  via pull request, gated by the same CI workflow. Once `develop` is in a
  good state, it's merged into `main` to cut the next release from.
- **`feature/<short-description>`** — short-lived branches for a single
  piece of work, branched from `develop`, merged back into `develop` via
  pull request.
- **Releases** are cut by running the `Cut Release` GitHub Actions
  workflow (Actions tab → Cut Release → Run workflow) from `main`, which
  bumps `package.json`'s version, adds a `CHANGELOG.md` entry from the
  text you give it, opens a PR into `main`, and auto-merges it once CI
  passes. Merging pushes the matching `vX.Y.Z` tag automatically, which
  triggers `.github/workflows/release.yml` (test → create the GitHub
  Release → build and publish Mac/Windows installers). No manual version
  bump, changelog edit, or tag push required.

```
feature/*  →  develop  →  main  →  Cut Release workflow  →  vX.Y.Z tag  →  release.yml
```

## Workflow

1. Branch from `develop`: `git checkout -b feature/my-change develop`
2. Make the change, with tests (`npm test` must pass locally).
3. Open a pull request into `develop`. CI (`.github/workflows/ci.yml`)
   runs the build and full test suite automatically.
4. Once `develop` is stable, open a pull request from `develop` into
   `main`.
5. Once that's merged, run the `Cut Release` workflow from the Actions
   tab, choosing a bump type (almost always `beta`, until this project
   leaves beta) and writing the changelog entry — everything from there
   (version bump, changelog, release PR, tag, signed installers) is
   automatic.

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
