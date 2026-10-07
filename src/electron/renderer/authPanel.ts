import { byId, errorMessage, withBusyLabel } from "./domHelpers.js";
import { isAllowedExternalUrl } from "../externalUrl.js";
import type { AuthStatus } from "./renderer.js";

// Architecture finding (code-review-and-quality pass, part 6 of
// renderer.ts's decomposition): the account sidebar section — Google
// sign-in/out and the linked GitHub connection — moved out of
// renderer.ts. The one thing it can't own itself is the session sidebar
// refresh a sign-out triggers (session history is filtered by the
// signed-in account server-side), so that becomes an injected callback
// rather than this module reaching back into renderer.ts for it.
// AuthStatus is a type genuinely owned by the AgentBridge interface in
// renderer.ts, imported back type-only (erased at compile time, so this
// isn't a real circular dependency).

const googleSignInBtn = byId<HTMLButtonElement>("google-sign-in");
const signOutBtn = byId<HTMLButtonElement>("sign-out-btn");
const githubConnectBtn = byId<HTMLButtonElement>("github-connect");
const githubDisconnectBtn = byId<HTMLButtonElement>("github-disconnect");
const githubNotConnectedEl = byId<HTMLDivElement>("github-not-connected");
const githubConnectedEl = byId<HTMLDivElement>("github-connected");
const githubConnectedAsEl = byId<HTMLSpanElement>("github-connected-as");
const githubDeviceCodeEl = byId<HTMLDivElement>("github-device-code");
const githubSettingsErrorEl = byId<HTMLDivElement>("github-settings-error");
const authSignedOut = byId<HTMLDivElement>("auth-signed-out");
const authSignedIn = byId<HTMLDivElement>("auth-signed-in");
const authAvatar = byId<HTMLSpanElement>("auth-avatar");
const authName = byId<HTMLSpanElement>("auth-name");
const authError = byId<HTMLDivElement>("auth-error");

export function renderAuthState(status: AuthStatus): void {
  authError.textContent = "";
  if (status.signedIn) {
    authSignedOut.hidden = true;
    authSignedIn.hidden = false;
    authName.textContent = `${status.name} · `;
    if (status.pictureUrl) {
      authAvatar.style.backgroundImage = `url(${JSON.stringify(status.pictureUrl)})`;
      authAvatar.textContent = "";
    } else {
      authAvatar.style.backgroundImage = "";
      authAvatar.textContent = status.name.slice(0, 1).toUpperCase();
    }
  } else {
    authSignedOut.hidden = false;
    authSignedIn.hidden = true;
  }
}

export async function refreshGithubStatus(): Promise<void> {
  const status = await window.agent.githubStatus();
  githubNotConnectedEl.hidden = status.connected;
  githubConnectedEl.hidden = !status.connected;
  if (status.connected) githubConnectedAsEl.textContent = `Connected as @${status.login}`;
}

export interface AuthPanelDeps {
  /** Refreshes the session sidebar after a successful sign-out — session history is filtered by the signed-in account server-side, so the sidebar must clear immediately rather than continuing to show the just-signed-out account's sessions until the next unrelated list refresh. */
  onSignedOut: () => Promise<void>;
}

export function initAuthPanel(deps: AuthPanelDeps): void {
  googleSignInBtn.addEventListener("click", () => {
    authError.textContent = "";
    // The whole flow — waiting for you to finish in the browser, plus
    // claiming unowned local sessions and running the Drive reconcile pass
    // — happens before this resolves, which can take real time. A plain
    // disabled button with no label change reads as frozen; this makes
    // clear it's actually working.
    void withBusyLabel(googleSignInBtn, "Signing in…", async () => {
      const result = await window.agent.googleSignIn();
      if ("error" in result) {
        authError.textContent = result.error;
      } else {
        renderAuthState({ signedIn: true, ...result });
      }
    });
  });

  signOutBtn.addEventListener("click", () => {
    authError.textContent = "";
    void withBusyLabel(signOutBtn, "Signing out…", async () => {
      try {
        await window.agent.signOut();
        renderAuthState({ signedIn: false });
        await deps.onSignedOut();
      } catch (err) {
        authError.textContent = errorMessage(err);
      }
    });
  });

  githubConnectBtn.addEventListener("click", () => {
    githubSettingsErrorEl.textContent = "";
    githubDeviceCodeEl.hidden = true;
    const stopListening = window.agent.onGithubDeviceCode((code) => {
      githubDeviceCodeEl.hidden = false;
      // Security/readability finding (code-review-and-quality pass): this
      // used to build the whole line as an HTML template literal — code's
      // userCode and verificationUri come from GitHub's device-flow
      // response (external data), the same "never parsed as HTML" rule
      // this file states explicitly elsewhere (renderMcpServerRow,
      // renderTabStrip's doc comments) for anything not typed by this
      // process. A malformed/compromised verificationUri set directly as
      // `.href` could also carry a javascript: scheme and execute on
      // click, not just render wrong — isAllowedExternalUrl (already used
      // for this app's other external-open paths) gates that.
      githubDeviceCodeEl.innerHTML = "";
      githubDeviceCodeEl.appendChild(document.createTextNode("Enter code "));
      const codeEl = document.createElement("strong");
      codeEl.textContent = code.userCode;
      githubDeviceCodeEl.appendChild(codeEl);
      githubDeviceCodeEl.appendChild(document.createTextNode(" at "));
      if (isAllowedExternalUrl(code.verificationUri)) {
        const link = document.createElement("a");
        link.href = code.verificationUri;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = code.verificationUri;
        githubDeviceCodeEl.appendChild(link);
      } else {
        githubDeviceCodeEl.appendChild(document.createTextNode(code.verificationUri));
      }
    });
    void withBusyLabel(githubConnectBtn, "Waiting for authorization…", async () => {
      try {
        const result = await window.agent.githubConnect();
        if ("error" in result) {
          githubSettingsErrorEl.textContent = result.error;
        } else {
          githubDeviceCodeEl.hidden = true;
          await refreshGithubStatus();
        }
      } finally {
        stopListening();
      }
    });
  });

  githubDisconnectBtn.addEventListener("click", () => {
    void withBusyLabel(githubDisconnectBtn, "Disconnecting…", async () => {
      await window.agent.githubDisconnect();
      await refreshGithubStatus();
    });
  });

  window.agent.onCloudSyncScopeWarning(() => {
    authError.textContent = "Sign in again to keep backing up your sessions to Google Drive.";
  });
}
