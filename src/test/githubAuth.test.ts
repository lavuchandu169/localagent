// src/test/githubAuth.test.ts
import {
  requestDeviceCode,
  pollForAccessToken,
  connectGithub,
  loadStoredGithubIdentity,
  saveStoredGithubIdentity,
  clearStoredGithubIdentity,
  getGithubAccessToken,
} from "../electron/githubAuth.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-github-auth-test-"));
  const filePath = path.join(dir, "github-auth.json");
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

console.log("requestDeviceCode:");
{
  const restore = fakeFetch((url) => {
    check("POSTs to github.com/login/device/code", url === "https://github.com/login/device/code");
    return new Response(
      JSON.stringify({
        device_code: "dc123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
      { status: 200 }
    );
  });
  try {
    const result = await requestDeviceCode("client-abc");
    check("returns the user code", result.userCode === "ABCD-1234");
    check("returns the verification URI", result.verificationUri === "https://github.com/login/device");
    check("returns the polling interval", result.intervalSeconds === 5);
  } finally {
    restore();
  }
}

console.log("\npollForAccessToken:");
{
  let callCount = 0;
  const restore = fakeFetch(() => {
    callCount++;
    if (callCount < 3) {
      return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 });
    }
    return new Response(JSON.stringify({ access_token: "gho_faketoken123456789012345678", token_type: "bearer", scope: "repo" }), { status: 200 });
  });
  try {
    const result = await pollForAccessToken("client-abc", "dc123", 0, /* maxAttempts */ 5);
    check("retries through authorization_pending", callCount === 3);
    check("resolves with the access token", result.kind === "ok" && result.accessToken === "gho_faketoken123456789012345678");
  } finally {
    restore();
  }
}
{
  const restore = fakeFetch(() => new Response(JSON.stringify({ error: "expired_token" }), { status: 200 }));
  try {
    const result = await pollForAccessToken("client-abc", "dc123", 0, 5);
    check("stops immediately on expired_token instead of polling forever", result.kind === "expired");
  } finally {
    restore();
  }
}
{
  const restore = fakeFetch(() => new Response(JSON.stringify({ error: "access_denied" }), { status: 200 }));
  try {
    const result = await pollForAccessToken("client-abc", "dc123", 0, 5);
    check("stops immediately on access_denied", result.kind === "denied");
  } finally {
    restore();
  }
}
{
  const restore = fakeFetch(() => new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 }));
  try {
    const result = await pollForAccessToken("client-abc", "dc123", 0, 3);
    check("gives up after maxAttempts rather than polling forever", result.kind === "expired");
  } finally {
    restore();
  }
}

console.log("\nidentity persistence:");
await withTempFile(async (filePath) => {
  const before = await loadStoredGithubIdentity(filePath);
  check("returns null when no identity file exists yet", before === null);

  await saveStoredGithubIdentity(filePath, { login: "octocat", accessToken: "gho_abc" });
  const after = await loadStoredGithubIdentity(filePath);
  check("round-trips the saved identity", after?.login === "octocat" && after?.accessToken === "gho_abc");

  const stat = await fs.stat(filePath);
  check("file is written with 0600 permissions", (stat.mode & 0o777) === 0o600);

  await clearStoredGithubIdentity(filePath);
  const afterClear = await loadStoredGithubIdentity(filePath);
  check("returns null after clearing", afterClear === null);
});

console.log("\ngetGithubAccessToken re-reads fresh (Review Focus: no stale token after disconnect):");
await withTempFile(async (filePath) => {
  await saveStoredGithubIdentity(filePath, { login: "octocat", accessToken: "gho_before" });
  const first = await getGithubAccessToken(filePath);
  check("returns the current token", first === "gho_before");

  await clearStoredGithubIdentity(filePath);
  const afterDisconnect = await getGithubAccessToken(filePath);
  check("returns null immediately after disconnect, not a cached value", afterDisconnect === null);
});

console.log("\nconnectGithub (end-to-end against a fake fetch):");
await withTempFile(async (filePath) => {
  const restore = fakeFetch((url) => {
    if (url === "https://github.com/login/device/code") {
      return new Response(
        JSON.stringify({ device_code: "dc1", user_code: "WXYZ-9999", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 }),
        { status: 200 }
      );
    }
    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify({ access_token: "gho_endtoend", token_type: "bearer", scope: "repo" }), { status: 200 });
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
    }
    throw new Error(`unexpected URL in test: ${url}`);
  });
  try {
    let shownCode: string | null = null;
    const result = await connectGithub("client-abc", filePath, undefined, (code) => {
      shownCode = code.userCode;
    });
    check("surfaces the user code before completing", shownCode === "WXYZ-9999");
    check("connects successfully", !("error" in result) && result.login === "octocat");
    const stored = await loadStoredGithubIdentity(filePath);
    check("persists the identity", stored?.login === "octocat" && stored?.accessToken === "gho_endtoend");
  } finally {
    restore();
  }
});

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
