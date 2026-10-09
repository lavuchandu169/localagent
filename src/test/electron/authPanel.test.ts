// authPanel.ts reads the global `document` via byId() AT MODULE LOAD TIME —
// same pattern as aboutPanel.test.ts, which this file's setup mirrors: load
// the real index.html (catching drift between renderer.ts's ids and the
// markup) and dynamically import after installing the jsdom document, so
// the module's top-level byId() calls run against a real document.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.join(__dirname, "../../electron/renderer/index.html");
const html = readFileSync(indexHtmlPath, "utf-8");

const dom = new JSDOM(html, { url: "https://example.com/" });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

type DeviceCodeCallback = (code: { userCode: string; verificationUri: string }) => void;

let googleSignInResult: { email: string; name: string; pictureUrl: string | null } | { error: string } = {
  email: "a@example.com",
  name: "Ada",
  pictureUrl: null,
};
let signOutCalls = 0;
let githubStatusResult: { connected: true; login: string } | { connected: false } = { connected: false };
let githubConnectResult: { login: string } | { error: string } = { login: "ada" };
let githubDisconnectCalls = 0;
let deviceCodeCallback: DeviceCodeCallback | null = null;
let stopListeningCalls = 0;
let cloudSyncScopeWarningCallback: (() => void) | null = null;

function sleepForMock(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(dom.window as any).agent = {
  googleSignIn: async () => googleSignInResult,
  signOut: async () => {
    signOutCalls++;
  },
  githubStatus: async () => githubStatusResult,
  // A real device-flow connect takes real time (the user has to go
  // authorize on github.com) — the device code arrives via the callback
  // WHILE this is still pending, not after. A delay here keeps that
  // ordering realistic instead of resolving before the test ever gets a
  // chance to fire the device code callback.
  githubConnect: async () => {
    await sleepForMock(5);
    return githubConnectResult;
  },
  githubDisconnect: async () => {
    githubDisconnectCalls++;
  },
  onGithubDeviceCode: (cb: DeviceCodeCallback) => {
    deviceCodeCallback = cb;
    return () => {
      stopListeningCalls++;
    };
  },
  onCloudSyncScopeWarning: (cb: () => void) => {
    cloudSyncScopeWarningCallback = cb;
    return () => {};
  },
};

const { renderAuthState, refreshGithubStatus, initAuthPanel } = await import("../../electron/renderer/authPanel.js");

const googleSignInBtn = dom.window.document.getElementById("google-sign-in") as any;
const signOutBtn = dom.window.document.getElementById("sign-out-btn") as any;
const githubConnectBtn = dom.window.document.getElementById("github-connect") as any;
const githubDisconnectBtn = dom.window.document.getElementById("github-disconnect") as any;
const githubNotConnectedEl = dom.window.document.getElementById("github-not-connected") as any;
const githubConnectedEl = dom.window.document.getElementById("github-connected") as any;
const githubConnectedAsEl = dom.window.document.getElementById("github-connected-as") as any;
const githubDeviceCodeEl = dom.window.document.getElementById("github-device-code") as any;
const githubSettingsErrorEl = dom.window.document.getElementById("github-settings-error") as any;
const authSignedOut = dom.window.document.getElementById("auth-signed-out") as any;
const authSignedIn = dom.window.document.getElementById("auth-signed-in") as any;
const authAvatar = dom.window.document.getElementById("auth-avatar") as any;
const authName = dom.window.document.getElementById("auth-name") as any;
const authError = dom.window.document.getElementById("auth-error") as any;

let onSignedOutCalls = 0;
initAuthPanel({
  onSignedOut: async () => {
    onSignedOutCalls++;
  },
});

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log("renderAuthState:");
{
  renderAuthState({ signedIn: false });
  check("signed out shows the signed-out section", authSignedOut.hidden === false);
  check("signed out hides the signed-in section", authSignedIn.hidden === true);
}
{
  renderAuthState({ signedIn: true, email: "a@example.com", name: "Ada Lovelace", pictureUrl: null });
  check("signed in shows the signed-in section", authSignedIn.hidden === false);
  check("signed in hides the signed-out section", authSignedOut.hidden === true);
  check("the name is rendered", authName.textContent === "Ada Lovelace · ");
  check("with no picture, the avatar falls back to the first letter of the name, uppercased", authAvatar.textContent === "A");
  check("with no picture, no stale background-image is left set", authAvatar.style.backgroundImage === "");
}
{
  renderAuthState({ signedIn: true, email: "a@example.com", name: "Ada", pictureUrl: "https://example.com/pic.png" });
  check("a real picture URL is set as the avatar's background-image", authAvatar.style.backgroundImage.includes("example.com/pic.png"));
  check("with a real picture, the text fallback (initial letter) is cleared", authAvatar.textContent === "");
}
{
  renderAuthState({ signedIn: false });
  check("calling renderAuthState always clears any previous auth error first", authError.textContent === "");
}

console.log("\nrefreshGithubStatus:");
{
  githubStatusResult = { connected: false };
  await refreshGithubStatus();
  check("not connected shows the not-connected section", githubNotConnectedEl.hidden === false);
  check("not connected hides the connected section", githubConnectedEl.hidden === true);
}
{
  githubStatusResult = { connected: true, login: "ada" };
  await refreshGithubStatus();
  check("connected hides the not-connected section", githubNotConnectedEl.hidden === true);
  check("connected shows the connected section", githubConnectedEl.hidden === false);
  check("connected shows the actual GitHub login", githubConnectedAsEl.textContent === "Connected as @ada");
}

console.log("\ngoogleSignInBtn click:");
{
  googleSignInResult = { email: "a@example.com", name: "Ada", pictureUrl: null };
  googleSignInBtn.dispatchEvent(new dom.window.Event("click"));
  await sleep(10);
  check("a successful sign-in renders the signed-in state", authSignedIn.hidden === false);
}
{
  googleSignInResult = { error: "network error" };
  googleSignInBtn.dispatchEvent(new dom.window.Event("click"));
  await sleep(10);
  check("a failed sign-in surfaces the error message instead of rendering signed-in", authError.textContent === "network error");
}

console.log("\nsignOutBtn click:");
{
  signOutCalls = 0;
  onSignedOutCalls = 0;
  signOutBtn.dispatchEvent(new dom.window.Event("click"));
  await sleep(10);
  check("sign-out actually calls window.agent.signOut", signOutCalls === 1);
  check("sign-out renders the signed-out state", authSignedOut.hidden === false);
  check("sign-out refreshes the session sidebar via the injected callback", onSignedOutCalls === 1);
}

console.log("\ngithubConnectBtn click and device code flow:");
{
  deviceCodeCallback = null;
  githubConnectResult = { login: "ada" };
  githubStatusResult = { connected: true, login: "ada" };
  githubConnectBtn.dispatchEvent(new dom.window.Event("click"));
  await sleep(1);
  check("clicking Connect starts listening for a device code", deviceCodeCallback !== null);

  deviceCodeCallback!({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
  check("the device code is shown once the callback fires", githubDeviceCodeEl.hidden === false);
  check("the user code appears in the panel", githubDeviceCodeEl.textContent?.includes("ABCD-1234"));
  check("an allowed https verification URL is rendered as a real clickable link", githubDeviceCodeEl.querySelector("a")?.href === "https://github.com/login/device");

  await sleep(10);
  check("once githubConnect resolves successfully, the device code panel is hidden again", githubDeviceCodeEl.hidden === true);
  check("the device-code listener is stopped once the flow finishes", stopListeningCalls > 0);
}
{
  // Security finding (code-review-and-quality pass): a malformed/
  // disallowed verificationUri must render as plain text, never as a
  // clickable href — isAllowedExternalUrl gates this exactly like the
  // app's other external-open paths.
  deviceCodeCallback = null;
  githubConnectBtn.dispatchEvent(new dom.window.Event("click"));
  await sleep(1);
  deviceCodeCallback!({ userCode: "WXYZ-5678", verificationUri: "javascript:alert(1)" });
  check("a disallowed verificationUri scheme is never rendered as a clickable link", githubDeviceCodeEl.querySelector("a") === null);
  check("it's still shown as plain text so the user isn't left with no information at all", githubDeviceCodeEl.textContent?.includes("javascript:alert(1)"));
  await sleep(10); // let this click's own in-flight withBusyLabel settle before the next click
}
{
  githubConnectResult = { error: "denied" };
  githubConnectBtn.dispatchEvent(new dom.window.Event("click"));
  await sleep(10);
  check("a failed device-flow connect surfaces its error", githubSettingsErrorEl.textContent === "denied");
}

console.log("\ngithubDisconnectBtn click:");
{
  githubDisconnectCalls = 0;
  githubStatusResult = { connected: false };
  githubDisconnectBtn.dispatchEvent(new dom.window.Event("click"));
  await sleep(10);
  check("disconnect actually calls window.agent.githubDisconnect", githubDisconnectCalls === 1);
  check("disconnect refreshes the connection status afterward", githubNotConnectedEl.hidden === false);
}

console.log("\ncloud sync scope warning:");
{
  authError.textContent = "";
  check("the scope-warning listener was registered during initAuthPanel", cloudSyncScopeWarningCallback !== null);
  cloudSyncScopeWarningCallback!();
  check("firing it surfaces a re-sign-in prompt in the auth error area", authError.textContent.includes("Sign in again"));
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
