# Changelog

All notable changes to localagent are documented here, newest first. Every
entry corresponds to a tagged [GitHub Release](https://github.com/lavuchandu169/localagent/releases).

## v0.1.0-beta.25 — 2026-09-03

- Per-hunk diff approval: when the agent proposes an edit, each changed
  section of the diff now has its own checkbox (checked by default) —
  uncheck the ones you don't want before approving, and only the checked
  changes get written. A plain "Approve" with everything checked still
  behaves exactly as before.

## v0.1.0-beta.24 — 2026-09-03

- A "what's new" popup now shows once after updating to a new version,
  right in the app — no more digging through the GitHub release page to
  see what changed.
- When you're using a Claude model, the status bar now shows a running
  estimate of tokens used and cost so far this session, updated live as
  the task runs.

## v0.1.0-beta.23 — 2026-09-03

- Automatic updates: a new version now downloads itself in the background
  with no click required, then offers a one-click "Restart Now" to apply
  it — or it applies itself the next time the app quits normally. Every
  failure (offline, a blocked install, anything else) falls back to the
  same manual "here's the release page" banner as before, so this never
  behaves worse than today even before this app is code-signed. Mac
  releases now also publish a `.zip` alongside the `.dmg`, which the
  updater needs to actually apply an update.

## v0.1.0-beta.22 — 2026-09-03

- File attachments: attach text and image files from anywhere on disk to
  a task via the new paperclip button (up to 5 per task). Claude sees
  images directly; the custom-server option sends them in the standard
  OpenAI vision format; local embedded models honestly say they can't
  see an attached image rather than silently ignoring it. Text files
  fold into the task text; large ones (over 200KB) are truncated rather
  than rejected, images over 5MB are rejected with a clear message.
  Attachments stay local — only the task text and model replies sync to
  Drive, never the attachment content itself.

## v0.1.0-beta.21 — 2026-09-02

- New "Plan first" option (off by default): hold a task's very first
  move — the files it wants to read/write or the command it wants to
  run — for your approval before any of it executes, instead of only
  finding out after the fact. Approve and it proceeds exactly as
  proposed; reject and nothing runs, nothing changes.

## v0.1.0-beta.20 — 2026-09-02

- A new "Research & Reasoning" model group in the Model dropdown, with
  three bigger local models: Qwen2.5 14B Instruct, DeepSeek-R1-Distill-
  Qwen 14B (reasoning-distilled, best for research/analysis), and
  Qwen2.5 32B Instruct (the most capable local option, clearly labeled
  as needing a powerful machine).

## v0.1.0-beta.19 — 2026-09-01

- Two more Claude models in the Cloud group, alongside Sonnet 5: Claude
  Opus 5 (most capable, for the hardest/largest tasks) and Claude Haiku
  4.5 (fastest and cheapest, for quick/simple tasks). Same saved API
  key as before — just pick the model per session.

## v0.1.0-beta.18 — 2026-09-01

- Fixed a real reliability gap: asked to create/build/design something,
  the embedded model could answer entirely in prose (code shown in
  markdown, nothing ever written to disk) instead of actually calling
  edit_file. Now caught and corrected at runtime — verified live
  against the exact reported failure, which now writes real files.
- Along the way, fixed a related embedded-model quirk: when it falls
  back to writing a tool call as JSON text, one inconsistently-escaped
  quote could break recovery entirely; that JSON is now repaired
  best-effort instead of being discarded.

## v0.1.0-beta.17 — 2026-09-01

- New logo: a lambda mark on the dark IDE badge, replacing the old
  cream/terracotta ring-and-dot from the retired warm-paper theme —
  in the header and the packaged app icon.
- A GitHub-style "Files changed" view: a "Changes" button next to
  "Revert this task" opens a panel listing every file changed since
  the task's checkpoint (added/modified/deleted, +/- counts), each
  with its full diff — everything the task has done so far, in one
  place, instead of scattered across individual approval prompts.

## v0.1.0-beta.16 — 2026-09-01

- Redesigned the UI as a switchable dark IDE theme: an activity bar,
  an Explorer-style session sidebar, a tab for the open session, a
  status bar, chat turns with a colored gutter instead of bubbles,
  and tool calls as inline diagnostics. Two themes (Settings > Theme):
  Warm Dark (default) and Mono Ink.
- Chat-first: once a session starts, the setup form collapses out of
  the way and the chat fills the window, with the composer docked to
  the bottom. "Edit settings…" brings the form back.
- Fixed the Model dropdown overflowing past the window edge on its
  longest option label.

## v0.1.0-beta.15 — 2026-09-01

- A real diff viewer: before you approve an edit, see the actual colored
  +/- line-level diff, not just a filename. Computed before the tool
  ever runs and attached to the permission-request regardless of the
  decision, so you can see what a denied edit would have changed too.
- One-checkpoint-per-task revert for git workspaces: before a task's
  first write or command, the whole workspace (tracked and untracked
  files) is snapshotted into a real git commit via a scratch index —
  never touches your actual index, HEAD, or branch. A "Revert this
  task" button appears once a checkpoint exists; reverting restores
  everything to that point, including removing files the task created
  since. Not offered outside a git repo, and refuses while a task is
  actively running.

## v0.1.0-beta.14 — 2026-08-31

- This file — a running history of every release, instead of scanning
  individual tag descriptions.
- Local-only crash/error capture: Electron's native crash reporter and
  new JS-level exception/rejection handlers (main + renderer) all log
  to a local file only, never uploaded anywhere. "Open error log" link
  added to the About panel.

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
