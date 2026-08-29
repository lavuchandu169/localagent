# Desktop app packaging (.dmg / .exe) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a working, downloadable beta installer for both macOS (`.dmg`) and Windows (`.exe`), built via `electron-builder` and published automatically from GitHub Actions on a version tag push.

**Architecture:** `electron-builder` config lives in `package.json`. Local `npm run package:mac`/`package:win` scripts build directly; a new CI workflow runs the same scripts on real `macos-latest`/`windows-latest` runners and publishes both artifacts to one GitHub Release per tag. No signing, no auto-update, no Linux target — all explicitly deferred.

**Tech Stack:** `electron-builder` (new devDependency), GitHub Actions.

**Spec:** [docs/superpowers/specs/2026-08-29-packaging-design.md](../specs/2026-08-29-packaging-design.md)

## Global Constraints

- `electron-builder`'s output directory must be `release/`, not its default `dist/` — the existing `tsc` build already writes there, and packaging reads that output as its input.
- `asarUnpack` must include `**/*.node` — `node-llama-cpp`'s native binaries cannot execute from inside an `.asar` archive.
- Builds are unsigned for this beta — no code-signing config, no new secrets in CI beyond the `GITHUB_TOKEN` GitHub Actions already provides.
- `package.json`'s `version` becomes exactly `0.1.0-beta.1`.
- Icon source is the existing `src/electron/renderer/icon-512.png` — no new icon asset needed.

---

### Task 1: `electron-builder` config, scripts, and version bump

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm run package:mac`, `npm run package:win`, `npm run package:all` scripts, and the `build` config block — consumed by Task 2 (local verification) and Task 3 (CI workflow, which calls these same scripts).

- [ ] **Step 1: Install `electron-builder`**

Run: `npm install --save-dev electron-builder`

Expected: `package.json`'s `devDependencies` gains an `electron-builder` entry; `npm install` exits 0.

- [ ] **Step 2: Add the `build` config block to `package.json`**

Add this top-level key to `package.json` (a sibling of `"scripts"`, `"dependencies"`, etc.):

```json
"build": {
  "appId": "com.chandulavu.localagent",
  "productName": "localagent",
  "directories": {
    "output": "release"
  },
  "files": [
    "dist/**/*",
    "package.json"
  ],
  "asarUnpack": [
    "**/*.node"
  ],
  "mac": {
    "category": "public.app-category.developer-tools",
    "icon": "src/electron/renderer/icon-512.png",
    "target": [
      { "target": "dmg", "arch": ["arm64", "x64"] }
    ]
  },
  "win": {
    "icon": "src/electron/renderer/icon-512.png",
    "target": [
      { "target": "nsis", "arch": ["x64"] }
    ]
  },
  "publish": {
    "provider": "github"
  }
}
```

- [ ] **Step 3: Add the three packaging scripts to `package.json`'s `"scripts"` block**

Add these three entries alongside the existing `"build"`, `"start"`, `"demo"`, `"test"`, `"electron"` scripts:

```json
"package:mac": "npm run build && electron-builder --mac",
"package:win": "npm run build && electron-builder --win",
"package:all": "npm run build && electron-builder -mw"
```

- [ ] **Step 4: Bump the version**

Change `package.json`'s top-level `"version"` field from `"0.1.0"` to `"0.1.0-beta.1"`.

- [ ] **Step 5: Gitignore the packaging output**

Add a line to `.gitignore`:

```
release/
```

(Add it after the existing `dist/` line, so the two build-output entries stay grouped together.)

- [ ] **Step 6: Verify the tool installed and the config parses**

Run: `npx electron-builder --help`

Expected: prints electron-builder's help text (proves the binary installed correctly) with no config-parsing errors. This does not build anything yet — just confirms the config in `package.json` is valid JSON electron-builder can read.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "feat: add electron-builder packaging config for beta release"
```

---

### Task 2: Build and live-verify the macOS `.dmg`

**Files:**
- No source files change in this task — it's a build-and-verify step.

**Interfaces:**
- Consumes: Task 1's `npm run package:mac` script and `build` config.
- Produces: a real, verified `.dmg` in `release/` — this task's evidence is the verification output itself, not a code change.

- [ ] **Step 1: Build the `.dmg`**

Run: `npm run package:mac`

Expected: exits 0; `release/` now contains two `.dmg` files (arm64 and x64 builds), named per the `0.1.0-beta.1` version (e.g. `localagent-0.1.0-beta.1-arm64.dmg`).

- [ ] **Step 2: Mount the `.dmg` matching this machine's architecture and confirm the `.app` is inside**

Run (adjust the filename to match what Step 1 actually produced, and this machine's real architecture — check with `uname -m`):

```bash
hdiutil attach release/localagent-0.1.0-beta.1-arm64.dmg
ls /Volumes/localagent*/
```

Expected: a mounted volume containing `localagent.app`.

- [ ] **Step 3: Launch the packaged app for real and confirm it actually starts**

This is the step that actually validates the packaging (native module intact, `asarUnpack` correct, icon loads, no missing-file errors) — a build exiting 0 does not prove the packaged app runs. Use Playwright (`npm install --no-save playwright-core`, matching the pattern already used elsewhere in this project for live Electron verification) to launch the actual bundled binary directly — not `node_modules/electron`, the real packaged executable inside the mounted `.app`:

```javascript
import { _electron as electron } from "playwright-core";

const app = await electron.launch({
  executablePath: "/Volumes/localagent 0.1.0-beta.1-arm64/localagent.app/Contents/MacOS/localagent",
});
const win = await app.firstWindow();
await win.waitForLoadState("domcontentloaded");
const signInVisible = await win.locator("#google-sign-in").isVisible().catch(() => false);
console.log("app launched from the packaged .dmg, sign-in button visible:", signInVisible);
await app.close();
```

(Adjust the mounted-volume path to whatever Step 2 actually showed — `hdiutil`'s mount point name includes the exact version string and may need URL-decoding/quoting if it contains spaces.)

Expected: the script prints `sign-in button visible: true` with no launch errors — proving the app opens, loads its renderer, and runs from the packaged, asar-archived, unpacked-native-module bundle exactly as a real user's copy would.

- [ ] **Step 4: Clean up**

```bash
hdiutil detach /Volumes/localagent*
npm uninstall --no-save playwright-core
```

- [ ] **Step 5: Report the verification result**

No commit for this task (nothing in git changed) — record in the task report that the `.dmg` was built, mounted, and the packaged app launched and rendered correctly.

---

### Task 3: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: Task 1's `npm run package:mac` / `npm run package:win` scripts.
- Produces: a workflow triggered on pushing a tag matching `v*`.

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  build-mac:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run package:mac -- --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  build-win:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run package:win -- --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Verify the workflow file is valid YAML**

Run: `node -e "require('node:fs').readFileSync('.github/workflows/release.yml', 'utf-8')" && python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/release.yml'))" 2>/dev/null || node -e "const yaml=require('node:fs').readFileSync('.github/workflows/release.yml','utf-8'); if (!yaml.includes('runs-on: macos-latest') || !yaml.includes('runs-on: windows-latest')) process.exit(1)"`

(If `python3`/`yaml` isn't available, the fallback Node check above just confirms both job blocks are present — full syntax validation happens for real the first time GitHub Actions parses it, in Task 4's live tag-push test.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat: add GitHub Actions release workflow for beta packaging"
```

---

### Task 4: README documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- None — documentation only.

- [ ] **Step 1: Add a "Download the beta" section**

Add this new section to `README.md`, placed right after the `## Desktop app` section's existing intro paragraph and before `### Google sign-in and cloud backup` (find that exact insertion point in the current file before editing — the surrounding text may have shifted since this plan was written):

```markdown
### Download the beta

Prebuilt installers are attached to each [GitHub Release](https://github.com/lavuchandu169/localagent/releases) — no `npm install`/`npm run build` needed.

These are unsigned builds (no Apple Developer or Windows code-signing
certificate behind them yet), so your OS will show a one-time warning
on first launch — normal for a beta, not a sign anything's wrong:

- **macOS**: Gatekeeper blocks it ("cannot be opened because the
  developer cannot be verified"). Right-click the app → **Open** →
  confirm in the dialog. Only needed once.
- **Windows**: SmartScreen shows "Windows protected your PC." Click
  **More info** → **Run anyway**. Only needed once.
```

- [ ] **Step 2: Update the "out of scope" section**

Find the `## What's deliberately out of scope` section's bullet list. Remove `packaging/installers` from the list of things NOT built (it now is), keeping the rest of that sentence's items intact. Read the exact current wording before editing, since it's a comma-separated list embedded in prose, not a bullet list — remove only that one item cleanly.

- [ ] **Step 3: Add a TOC entry**

Add `- [Download the beta](#download-the-beta)` to the `## Contents` list, nested under the `- [Desktop app](#desktop-app)` entry, matching the existing nesting style used for `Google sign-in and cloud backup` and the others.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document beta installer downloads"
```

---

## Plan self-review notes

- Spec coverage: tool choice (Task 1), the `dist/`-collision fix (Task 1 Step 2), `asarUnpack` (Task 1 Step 2), icons (Task 1 Step 2, reuses existing asset per spec), versioning (Task 1 Step 4), local scripts (Task 1 Step 3), CI workflow (Task 3), unsigned-build user experience documented (Task 4), live verification instead of unit tests (Task 2, matching the spec's own Testing section and this project's established treatment of Electron-only code).
- No placeholders — every step has real, complete config/commands, not descriptions of what to do.
- Explicitly NOT a task in this plan (per spec's "Out of scope"): actually pushing a `v0.1.0-beta.1` tag to trigger the real CI run and cut the first public GitHub Release. That's an outward-facing, semi-irreversible action (creates a public release) — it happens after this plan's tasks are done and reviewed, as an explicit, separate step the controller asks the user to confirm before doing.
