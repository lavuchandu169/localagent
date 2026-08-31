# Changelog

All notable changes to localagent are documented here, newest first. Every
entry corresponds to a tagged [GitHub Release](https://github.com/lavuchandu169/localagent/releases).

## v0.1.0-beta.13 — 2026-08-31

- First-run onboarding modal explaining the Model dropdown's Embedded /
  Claude / Custom-server choices, shown once.
- Accessibility pass: `aria-live` on the event log so screen readers
  announce agent activity live, `aria-label` on icon-only buttons, focus
  management for panels (opening moves focus in, closing returns it,
  Escape closes whichever's open).
- A "Report an issue" link in the About panel, pre-filled with app
  version, OS/platform, and hardware info.

## v0.1.0-beta.12 — 2026-08-31

- CI now runs the full test suite and blocks the entire release
  (including the empty release shell) if it fails — previously nothing
  in CI ran `npm test` at all.
- An in-app update-available banner: checks GitHub once per launch
  (packaged builds only) and links to the release page. Notify-only, not
  silent auto-install — that generally needs a signed app on macOS,
  which this isn't yet.

## v0.1.0-beta.11 — 2026-08-31

- Fixed confusing model selection: the setup screen had two competing
  controls — a visible Model dropdown and a separate collapsed
  "Advanced" section with radio buttons that silently overrode it.
  Collapsed into one dropdown grouped by Coding / Chat / Cloud (Claude
  Sonnet 5) / Custom server, so what's shown is always what actually runs.

## v0.1.0-beta.10 — 2026-08-31

- New: add your own Anthropic API key in the Settings panel to use
  Claude from the packaged installers, no terminal or `.env` needed.

## v0.1.0-beta.9 — 2026-08-31

- Fixed the root cause behind "changing the model isn't supported while
  a session is active": `EmbeddedLlamaProvider` never disposed the
  native Llama backend instance itself (only the model/context built on
  top of it), leaking it on every teardown and crashing the whole
  process when a second embedded model loaded shortly after. Switching
  embedded models mid-session now fully works.

## v0.1.0-beta.8 — 2026-08-31

- Fixed a real Windows performance regression from beta.5/6: the
  installer-size fix had accidentally removed GPU acceleration
  entirely, forcing CPU-only inference on every Windows machine. Vulkan
  restored (NVIDIA/AMD/Intel); CUDA stays excluded (NVIDIA-only, needs a
  363MB companion package).
- New: cancel an in-progress model download; delete a downloaded model
  to free disk space; edit an active session's workspace/mode without
  losing its conversation (model-switching mid-session was blocked in
  this release — fixed in beta.9).

## v0.1.0-beta.7 — 2026-08-31

- Fixed the Vulkan GPU backend being dropped alongside CUDA in beta.5's
  installer-size fix, which had silently forced all Windows users onto
  CPU-only inference.

## v0.1.0-beta.6 — 2026-08-30

- Further installer-size reduction: Electron's Chromium locale files
  pruned to English-only, and the unused win-arm64 node-llama-cpp
  backend excluded (this app only ships an x64 Windows build).

## v0.1.0-beta.5 — 2026-08-30

- Fixed the Windows installer's size: excluded node-llama-cpp's optional
  CUDA/CUDA-fallback/Vulkan GPU backend binaries from packaging (~500MB
  of dead weight for most machines). CPU inference unaffected via
  automatic fallback. (This release also silently regressed GPU
  acceleration on Windows — see beta.7/8.)

## v0.1.0-beta.4 — 2026-08-30

- Fixed the release CI's duplicate-release race condition: a
  `create-release` job now runs before `build-mac`/`build-win`, so the
  GitHub Release exists once before either build job publishes to it.

## v0.1.0-beta.3 — 2026-08-30

- Embeds a working Google OAuth Client ID/Secret into official release
  builds at CI time, so Google sign-in and Drive backup work
  immediately in the `.dmg`/`.exe` with no setup. The in-app Settings
  panel (beta.2) remains available for anyone who wants their own
  Google Cloud project instead.

## v0.1.0-beta.2 — 2026-08-30

- Adds an in-app Settings panel for configuring Google OAuth
  credentials, so Google sign-in and Drive backup work in the packaged
  `.dmg`/`.exe` without a terminal or `.env` file.

## v0.1.0-beta.1 — 2026-08-29

- First public beta: macOS (`.dmg`, arm64) and Windows (`.exe`, x64)
  installers, built and published via GitHub Actions.
