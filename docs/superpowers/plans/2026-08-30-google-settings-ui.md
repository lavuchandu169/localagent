# In-app Google OAuth Settings implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user configure their Google OAuth Client ID/Secret from inside the app itself (a new Settings panel), so Google sign-in works in the distributed `.dmg`/`.exe`, not just when running from source with a `.env`.

**Architecture:** A new Electron-free `googleSettings.ts` (mirroring `googleAuth.ts`'s identity-storage functions) persists credentials to a userData-dir JSON file, encrypted at rest via the same `secureStorage.ts` machinery already built for the refresh token. A new `resolveGoogleCredentials` helper replaces every direct `process.env.GOOGLE_OAUTH_CLIENT_ID`/`SECRET` read in `main.ts`, falling back to the saved settings only when no environment variable is set. A new Settings panel in the renderer (structurally identical to the existing About panel) reads/writes these via two new IPC channels.

**Tech Stack:** TypeScript, Electron IPC, `safeStorage` (already integrated via `secureStorage.ts`). No new dependencies.

**Spec:** [docs/superpowers/specs/2026-08-30-google-settings-ui-design.md](../specs/2026-08-30-google-settings-ui-design.md)

## Global Constraints

- Settings scope is Google OAuth Client ID/Secret only — no other env-configurable values.
- An explicitly-set `GOOGLE_OAUTH_CLIENT_ID` environment variable always wins over saved settings (matches `loadEnvFile`'s existing rule).
- The Client Secret is never sent back to the renderer once saved — only whether one exists (`hasSecret: boolean`).
- Saving a Client ID with the secret field left untouched (the masked placeholder) must NOT overwrite the previously-saved secret.
- The secret is encrypted at rest via the existing `StorageCrypto`/`secureStorage.ts` mechanism — same pattern as `auth.json`, no new dependency.
- No validation of entered credentials beyond the existing sign-in error flow.

---

### Task 1: `googleSettings.ts` — storage + precedence resolution

**Files:**
- Create: `src/electron/googleSettings.ts`
- Create: `src/test/googleSettings.test.ts`
- Modify: `package.json` (append the new test file to the chained `"test"` script)

**Interfaces:**
- Consumes: `StorageCrypto` type from `src/electron/googleAuth.ts` (already exported there — `{ encrypt: (plainText: string) => string; decrypt: (cipherText: string) => string }`).
- Produces: `loadGoogleSettings(settingsFilePath, storageCrypto?)`, `saveGoogleSettings(settingsFilePath, settings, storageCrypto?)`, `resolveGoogleCredentials(settingsFilePath, storageCrypto?)` — consumed by Task 2 (`main.ts`).

- [ ] **Step 1: Write the failing tests**

Create `src/test/googleSettings.test.ts`:

```typescript
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  loadGoogleSettings,
  saveGoogleSettings,
  resolveGoogleCredentials,
  type GoogleSettings,
} from "../electron/googleSettings.js";
import type { StorageCrypto } from "../electron/googleAuth.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

/** Not real encryption — just reversible enough to prove the plumbing actually calls encrypt on write and decrypt on read. */
const fakeStorageCrypto: StorageCrypto = {
  encrypt: (plainText) => Buffer.from(plainText, "utf-8").toString("base64"),
  decrypt: (cipherText) => Buffer.from(cipherText, "base64").toString("utf-8"),
};

console.log("googleSettings storage:");

async function runStorageTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-google-settings-test-"));

  const missing = await loadGoogleSettings(path.join(dir, "nope.json"));
  check("loading a nonexistent file returns null clientId and clientSecret", missing.clientId === null && missing.clientSecret === null);

  const settingsFile = path.join(dir, "googleSettings.json");
  const settings: GoogleSettings = { clientId: "abc.apps.googleusercontent.com", clientSecret: "shh" };
  await saveGoogleSettings(settingsFile, settings);
  const loaded = await loadGoogleSettings(settingsFile);
  check("saved settings round-trip through load (no crypto)", JSON.stringify(loaded) === JSON.stringify(settings));

  const cryptoFile = path.join(dir, "googleSettingsCrypto.json");
  await saveGoogleSettings(cryptoFile, settings, fakeStorageCrypto);
  const onDisk = await fs.readFile(cryptoFile, "utf-8");
  let onDiskIsPlainJson = true;
  try {
    JSON.parse(onDisk);
  } catch {
    onDiskIsPlainJson = false;
  }
  check("with a storageCrypto, the on-disk content is not plain JSON (it was actually transformed)", !onDiskIsPlainJson);
  const loadedWithCrypto = await loadGoogleSettings(cryptoFile, fakeStorageCrypto);
  check("saved-with-crypto settings round-trip through load with the same crypto", JSON.stringify(loadedWithCrypto) === JSON.stringify(settings));
  const loadedWithoutCrypto = await loadGoogleSettings(cryptoFile);
  check("an encrypted file read back without a storageCrypto returns null/null, not a crash", loadedWithoutCrypto.clientId === null && loadedWithoutCrypto.clientSecret === null);

  const corruptFile = path.join(dir, "corrupt.json");
  await fs.writeFile(corruptFile, "{not valid json", "utf-8");
  const loadedCorrupt = await loadGoogleSettings(corruptFile);
  check("a corrupted file returns null/null, not a crash", loadedCorrupt.clientId === null && loadedCorrupt.clientSecret === null);

  await fs.rm(dir, { recursive: true, force: true });
}

await runStorageTests();

console.log("\nresolveGoogleCredentials:");
async function runPrecedenceTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-google-settings-test-"));
  const settingsFilePath = path.join(dir, "googleSettings.json");
  const savedId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const savedSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  try {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

    const emptyResult = await resolveGoogleCredentials(settingsFilePath);
    check(
      "with no env var and no saved settings, resolves to an empty clientId and undefined secret",
      emptyResult.clientId === "" && emptyResult.clientSecret === undefined
    );

    await saveGoogleSettings(settingsFilePath, { clientId: "saved-id", clientSecret: "saved-secret" });
    const fromSettings = await resolveGoogleCredentials(settingsFilePath);
    check(
      "with no env var, falls back to saved settings",
      fromSettings.clientId === "saved-id" && fromSettings.clientSecret === "saved-secret"
    );

    process.env.GOOGLE_OAUTH_CLIENT_ID = "env-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "env-secret";
    const fromEnv = await resolveGoogleCredentials(settingsFilePath);
    check(
      "an explicit env var wins over saved settings",
      fromEnv.clientId === "env-id" && fromEnv.clientSecret === "env-secret"
    );
  } finally {
    if (savedId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = savedId;
    if (savedSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedSecret;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

await runPrecedenceTests();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

Append the compiled test to `package.json`'s `"test"` script (after `loadEnvFile.test.js`):

```json
"test": "node dist/test/agent.test.js && node dist/test/sessionRegistry.test.js && node dist/test/modeLabels.test.js && node dist/test/hardwareInfo.test.js && node dist/test/filenameCandidates.test.js && node dist/test/anthropicProvider.test.js && node dist/test/googleAuth.test.js && node dist/test/sessionStore.test.js && node dist/test/cloudSync.test.js && node dist/test/loadEnvFile.test.js && node dist/test/googleSettings.test.js",
```

- [ ] **Step 2: Run to verify RED**

Run: `npm run build && node dist/test/googleSettings.test.js`
Expected: build fails — `../electron/googleSettings.js` doesn't exist yet.

- [ ] **Step 3: Implement `src/electron/googleSettings.ts`**

```typescript
import fs from "node:fs/promises";
import type { StorageCrypto } from "./googleAuth.js";

export interface GoogleSettings {
  clientId: string | null;
  clientSecret: string | null;
}

export async function loadGoogleSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<GoogleSettings> {
  try {
    const raw = await fs.readFile(settingsFilePath, "utf-8");
    const json = storageCrypto ? storageCrypto.decrypt(raw) : raw;
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return { clientId: null, clientSecret: null };
    const s = parsed as Partial<GoogleSettings>;
    return {
      clientId: typeof s.clientId === "string" ? s.clientId : null,
      clientSecret: typeof s.clientSecret === "string" ? s.clientSecret : null,
    };
  } catch {
    return { clientId: null, clientSecret: null };
  }
}

export async function saveGoogleSettings(settingsFilePath: string, settings: GoogleSettings, storageCrypto?: StorageCrypto): Promise<void> {
  const json = JSON.stringify(settings, null, 2);
  const toWrite = storageCrypto ? storageCrypto.encrypt(json) : json;
  await fs.writeFile(settingsFilePath, toWrite, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Resolves the Google OAuth credentials actually used at runtime. An
 * explicitly-set environment variable always wins (matches loadEnvFile's
 * own "already-set env var wins over the file" rule) — saved Settings are
 * the fallback, exactly for the case that's broken in a packaged install
 * (no .env, no project root to find one in).
 */
export async function resolveGoogleCredentials(
  settingsFilePath: string,
  storageCrypto?: StorageCrypto
): Promise<{ clientId: string; clientSecret: string | undefined }> {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };
  }
  const settings = await loadGoogleSettings(settingsFilePath, storageCrypto);
  return { clientId: settings.clientId ?? "", clientSecret: settings.clientSecret ?? undefined };
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npm run build && node dist/test/googleSettings.test.js`
Expected: all checks pass, `0 test(s) failed`.

- [ ] **Step 5: Commit**

```bash
git add src/electron/googleSettings.ts src/test/googleSettings.test.ts package.json
git commit -m "feat: add persisted Google OAuth settings storage with env-var precedence"
```

---

### Task 2: `main.ts` wiring — IPC handlers and env-var call site replacement

**Files:**
- Modify: `src/electron/main.ts`
- Modify: `src/electron/googleAuth.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `loadGoogleSettings`, `saveGoogleSettings`, `resolveGoogleCredentials` from Task 1.
- Produces: two new IPC channels (`agent:get-google-settings`, `agent:save-google-settings`) — consumed by Task 3 (preload/renderer).

- [ ] **Step 1: Update the sign-in error message in `googleAuth.ts`**

Find this line in `src/electron/googleAuth.ts`:

```typescript
    return { error: "GOOGLE_OAUTH_CLIENT_ID is not set — see README for how to create one." };
```

Replace with:

```typescript
    return { error: "GOOGLE_OAUTH_CLIENT_ID is not set — add your Google OAuth credentials in Settings." };
```

- [ ] **Step 2: Wire `main.ts`**

Add to the import list:

```typescript
import { loadGoogleSettings, saveGoogleSettings, resolveGoogleCredentials } from "./googleSettings.js";
```

Add a `settingsFilePath` constant alongside the existing `authFilePath`/`sessionsDir`:

```typescript
  const authFilePath = path.join(app.getPath("userData"), "auth.json");
  const settingsFilePath = path.join(app.getPath("userData"), "googleSettings.json");
  const sessionsDir = path.join(app.getPath("userData"), "sessions");
```

Replace all four direct `process.env.GOOGLE_OAUTH_CLIENT_ID`/`process.env.GOOGLE_OAUTH_CLIENT_SECRET` read sites with a single `resolveGoogleCredentials` call each. Specifically:

In the `registry` construction, replace:

```typescript
  const registry = createSessionRegistry(sessionsDir, {
    getAccessToken: () =>
      getFreshAccessToken(authFilePath, process.env.GOOGLE_OAUTH_CLIENT_ID ?? "", process.env.GOOGLE_OAUTH_CLIENT_SECRET, storageCrypto),
    onScopeError: notifyScopeWarning,
    getOwnerEmail: () => getStoredEmail(authFilePath, storageCrypto),
  });
```

with:

```typescript
  const registry = createSessionRegistry(sessionsDir, {
    getAccessToken: async () => {
      const { clientId, clientSecret } = await resolveGoogleCredentials(settingsFilePath, storageCrypto);
      return getFreshAccessToken(authFilePath, clientId, clientSecret, storageCrypto);
    },
    onScopeError: notifyScopeWarning,
    getOwnerEmail: () => getStoredEmail(authFilePath, storageCrypto),
  });
```

In the `agent:google-sign-in` handler, replace:

```typescript
  ipcMain.handle("agent:google-sign-in", async () => {
    const result = await signInWithGoogle(
      process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      authFilePath,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      storageCrypto
    );
```

with:

```typescript
  ipcMain.handle("agent:google-sign-in", async () => {
    const signInCreds = await resolveGoogleCredentials(settingsFilePath, storageCrypto);
    const result = await signInWithGoogle(signInCreds.clientId, authFilePath, signInCreds.clientSecret, storageCrypto);
```

Later in that same handler, replace:

```typescript
        const token = await getFreshAccessToken(
          authFilePath,
          process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
          process.env.GOOGLE_OAUTH_CLIENT_SECRET,
          storageCrypto
        );
```

with:

```typescript
        const reconcileCreds = await resolveGoogleCredentials(settingsFilePath, storageCrypto);
        const token = await getFreshAccessToken(authFilePath, reconcileCreds.clientId, reconcileCreds.clientSecret, storageCrypto);
```

In the `agent:auth-status` handler, replace:

```typescript
  ipcMain.handle("agent:auth-status", () =>
    getAuthStatus(authFilePath, process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET, storageCrypto)
  );
```

with:

```typescript
  ipcMain.handle("agent:auth-status", async () => {
    const { clientId, clientSecret } = await resolveGoogleCredentials(settingsFilePath, storageCrypto);
    return getAuthStatus(authFilePath, clientId, clientSecret, storageCrypto);
  });
```

Add the two new IPC handlers — place them near the other `agent:*` handlers, e.g. right after `agent:auth-status`:

```typescript
  ipcMain.handle("agent:get-google-settings", async () => {
    const settings = await loadGoogleSettings(settingsFilePath, storageCrypto);
    return { clientId: settings.clientId ?? "", hasSecret: !!settings.clientSecret };
  });
  ipcMain.handle("agent:save-google-settings", async (_event, input: { clientId: string; clientSecret?: string }) => {
    const current = await loadGoogleSettings(settingsFilePath, storageCrypto);
    await saveGoogleSettings(
      settingsFilePath,
      {
        clientId: input.clientId || null,
        clientSecret: input.clientSecret !== undefined ? input.clientSecret || null : current.clientSecret,
      },
      storageCrypto
    );
  });
```

- [ ] **Step 3: Update `README.md`**

Find this row in the troubleshooting table (under "Google sign-in and cloud backup"):

```markdown
| `GOOGLE_OAUTH_CLIENT_ID is not set` | No client ID in the environment or `.env` | See step 5 above |
```

Replace with:

```markdown
| `GOOGLE_OAUTH_CLIENT_ID is not set` | No client ID in the environment, `.env`, or saved Settings | Running from source: see step 5 above. Running the packaged app: open Settings (gear icon in the header) and paste your Client ID/Secret there instead. |
```

Read the current file first to confirm this row's exact surrounding wording hasn't drifted — the README has been edited many times this session — and match the current table formatting exactly.

- [ ] **Step 4: Build and run the full suite**

Run: `npm run build && npm test`
Expected: build succeeds, all tests pass (this task changes no test files, but must not break Task 1's or any prior test).

- [ ] **Step 5: Commit**

```bash
git add src/electron/main.ts src/electron/googleAuth.ts README.md
git commit -m "feat: wire Google settings storage into main.ts, replacing direct env reads"
```

---

### Task 3: Settings panel UI

**Files:**
- Modify: `src/electron/renderer/index.html`
- Modify: `src/electron/renderer/renderer.ts`
- Modify: `src/electron/preload.cjs`

**Interfaces:**
- Consumes: `agent:get-google-settings` / `agent:save-google-settings` IPC channels from Task 2; the existing `withBusyLabel` helper already defined in `renderer.ts` (added in an earlier feature — search for `function withBusyLabel` before writing new busy-state handling, don't redefine it).

This task has no automated test coverage (matches this project's consistent treatment of Electron-only UI code) — verified live at the end via Playwright, the same way prior renderer features in this project were verified.

- [ ] **Step 1: Add the Settings toggle button and panel to `index.html`**

Find this line:

```html
            <button id="about-toggle" aria-expanded="false" title="About">?</button>
```

Insert a new button immediately before it (same `#header-right` container):

```html
            <button id="settings-toggle" aria-expanded="false" title="Settings">⚙</button>
            <button id="about-toggle" aria-expanded="false" title="About">?</button>
```

Find the closing `</div>` of `#about-panel` (the `<div id="about-panel" hidden>...</div>` block). Immediately after it, add a new sibling panel:

```html
        <div id="settings-panel" hidden>
          <p>Google sign-in needs your own OAuth Client ID (and sometimes a Client Secret) from Google Cloud Console. Saved locally, used only to sign in.</p>
          <ol>
            <li><a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a> → create or select a project.</li>
            <li>APIs &amp; Services → OAuth consent screen → configure it, add yourself as a test user (or publish to production).</li>
            <li>APIs &amp; Services → Credentials → Create Credentials → OAuth client ID → Application type: <strong>Desktop app</strong>.</li>
            <li>Copy the Client ID (and Client Secret, if Google issued one) below.</li>
          </ol>
          <label>
            Client ID
            <input id="settings-client-id" type="text" placeholder="your-client-id.apps.googleusercontent.com" />
          </label>
          <label>
            Client Secret <span class="hint-text">(only if Google asks for one)</span>
            <input id="settings-client-secret" type="password" placeholder="" />
          </label>
          <div id="settings-error" class="error-text"></div>
          <div id="settings-saved" class="hint-text" hidden>Saved.</div>
          <button id="settings-save">Save</button>
          <button id="settings-close">Close</button>
        </div>
```

Use the existing `label`, `input`, `.error-text`, and `.hint-text` styling already applied elsewhere in this file (e.g. the workspace/mode fields, `#auth-error`) — no new CSS classes needed; if the panel doesn't look right without a class matching `#about-panel`'s own styling, add `class="panel"` or whatever class `#about-panel` itself uses (check its exact class list in `styles.css` before assuming).

- [ ] **Step 2: Wire `preload.cjs`**

Add these two entries to the `contextBridge.exposeInMainWorld("agent", { ... })` object, right after the existing `onCloudSyncScopeWarning` entry:

```javascript
  getGoogleSettings: () => ipcRenderer.invoke("agent:get-google-settings"),
  saveGoogleSettings: (settings) => ipcRenderer.invoke("agent:save-google-settings", settings),
```

- [ ] **Step 3: Wire `renderer.ts`**

Add two methods to the `AgentBridge` interface, right after the existing `onCloudSyncScopeWarning` line:

```typescript
  getGoogleSettings(): Promise<{ clientId: string; hasSecret: boolean }>;
  saveGoogleSettings(settings: { clientId: string; clientSecret?: string }): Promise<void>;
```

Add element references near the other `byId` declarations (find where `aboutToggle`/`aboutPanel`/`aboutClose` are declared and add these alongside):

```typescript
const settingsToggle = byId<HTMLButtonElement>("settings-toggle");
const settingsPanel = byId<HTMLDivElement>("settings-panel");
const settingsClose = byId<HTMLButtonElement>("settings-close");
const settingsClientIdInput = byId<HTMLInputElement>("settings-client-id");
const settingsClientSecretInput = byId<HTMLInputElement>("settings-client-secret");
const settingsError = byId<HTMLDivElement>("settings-error");
const settingsSaved = byId<HTMLDivElement>("settings-saved");
const settingsSaveBtn = byId<HTMLButtonElement>("settings-save");
```

Add this logic near the existing `aboutToggle`/`aboutClose` event listeners (same general area of the file):

```typescript
// Tracks whether the user actually typed into the secret field this time
// it was open — saving must NOT overwrite a previously-saved secret just
// because the field displays its masked placeholder unchanged.
let settingsSecretTouched = false;
settingsClientSecretInput.addEventListener("input", () => {
  settingsSecretTouched = true;
});

async function openSettingsPanel(): Promise<void> {
  settingsError.textContent = "";
  settingsSaved.hidden = true;
  settingsSecretTouched = false;
  const current = await window.agent.getGoogleSettings();
  settingsClientIdInput.value = current.clientId;
  settingsClientSecretInput.value = "";
  settingsClientSecretInput.placeholder = current.hasSecret ? "•••• saved" : "";
}

settingsToggle.addEventListener("click", async () => {
  const opening = settingsPanel.hidden;
  if (opening) await openSettingsPanel();
  settingsPanel.hidden = !opening;
  settingsToggle.setAttribute("aria-expanded", String(opening));
});

settingsClose.addEventListener("click", () => {
  settingsPanel.hidden = true;
  settingsToggle.setAttribute("aria-expanded", "false");
});

settingsSaveBtn.addEventListener("click", () => {
  settingsError.textContent = "";
  settingsSaved.hidden = true;
  void withBusyLabel(settingsSaveBtn, "Saving…", async () => {
    try {
      await window.agent.saveGoogleSettings({
        clientId: settingsClientIdInput.value.trim(),
        clientSecret: settingsSecretTouched ? settingsClientSecretInput.value : undefined,
      });
      settingsSecretTouched = false;
      settingsSaved.hidden = false;
    } catch (err) {
      settingsError.textContent = err instanceof Error ? err.message : String(err);
    }
  });
});
```

`withBusyLabel` already exists in this file (added for the sign-in/sign-out responsiveness fix) — do not redefine it, just call it.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles with no errors.

- [ ] **Step 5: Manual live verification**

No automated test covers this file trio. Verify live:

1. `npm run electron` (or, if testing the .env-precedence behavior specifically, run without any `GOOGLE_OAUTH_CLIENT_ID` set in the environment/`.env`).
2. Click the new gear-icon Settings button in the header — confirm the panel opens, both fields are empty (assuming nothing saved yet), and the secret field's placeholder is empty (not "•••• saved").
3. Type a fake Client ID (e.g. `test-id.apps.googleusercontent.com`) and a fake secret (e.g. `test-secret`), click Save — confirm "Saved." appears.
4. Close the panel, reopen it — confirm the Client ID field now shows `test-id.apps.googleusercontent.com` and the secret field's placeholder now reads "•••• saved" (empty value, not the actual secret).
5. Change only the Client ID (leave the secret field alone, still showing the masked placeholder) and Save again. Then check the actual `googleSettings.json` file on disk (`~/Library/Application Support/localagent/googleSettings.json` on macOS) — confirm it still exists and its (encrypted) content changed size/bytes only once for the ID-only edit, i.e. the secret wasn't cleared. (You can't read the plaintext secret back out since it's encrypted — but confirm `hasSecret` is still `true` by reopening the panel and checking the placeholder is still "•••• saved", not empty.)
6. With no `GOOGLE_OAUTH_CLIENT_ID` environment variable set, click "Sign in with Google" — confirm it now actually attempts a real sign-in (opens the browser to Google's consent screen) using the saved Settings values, instead of showing the old "GOOGLE_OAUTH_CLIENT_ID is not set" error. (You don't need to complete the real Google login for this check — just confirm the browser opens, proving `resolveGoogleCredentials` picked up the saved settings correctly. Cancel out of the browser flow once confirmed.)
7. Confirm the inline error text (if you clear Settings and try signing in with nothing saved and no env var) now reads "...add your Google OAuth credentials in Settings." not "...see README...".

If any step fails, fix forward before moving on — do not commit broken wiring.

- [ ] **Step 6: Commit**

```bash
git add src/electron/renderer/index.html src/electron/renderer/renderer.ts src/electron/preload.cjs
git commit -m "feat: add in-app Settings panel for Google OAuth credentials"
```

---

## Plan self-review notes

- Spec coverage: storage + encryption reuse (Task 1), env-var-wins precedence (Task 1, tested explicitly), all 4 `main.ts` call sites replaced (Task 2, each one named explicitly with before/after code), the two new IPC channels (Task 2 produces, Task 3 consumes), secret-never-sent-back / masked-placeholder / untouched-secret-preserved behavior (Task 3, plus a dedicated manual verification step), the updated error message (Task 2, plus Task 3's verification step 7), README troubleshooting update (Task 2).
- No placeholders — every step has real, complete code.
- Type consistency checked: `GoogleSettings`, `StorageCrypto`, and the `{ clientId, clientSecret }` shapes match exactly across `googleSettings.ts`, `main.ts`, `preload.cjs`, and `renderer.ts`'s `AgentBridge` interface.
