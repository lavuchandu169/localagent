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
- **Releases** are cut from `main` by pushing a `vX.Y.Z` tag, which
  triggers `.github/workflows/release.yml` (test → create the GitHub
  Release → build and publish signed Mac/Windows installers).

```
feature/*  →  develop  →  main  →  tag (vX.Y.Z)  →  release.yml
```

## Workflow

1. Branch from `develop`: `git checkout -b feature/my-change develop`
2. Make the change, with tests (`npm test` must pass locally).
3. Open a pull request into `develop`. CI (`.github/workflows/ci.yml`)
   runs the build and full test suite automatically.
4. Once `develop` is stable, open a pull request from `develop` into
   `main`.
5. On `main`, bump `package.json`'s `version`, update `CHANGELOG.md`, and
   push a matching `vX.Y.Z` tag to trigger the release build.

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
