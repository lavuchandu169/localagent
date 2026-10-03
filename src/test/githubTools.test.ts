// src/test/githubTools.test.ts
import { createGithubCreateRepoTool, createGithubCreatePrTool } from "../electron/githubTools.js";

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

const ctx = { workspaceRoot: "/tmp", log: () => {} };

console.log("github_create_repo:");
{
  const tool = createGithubCreateRepoTool(async () => "gho_faketoken");
  check("declares NETWORK permission (Global Constraint: always ASK)", tool.permission === "NETWORK");

  let capturedUrl = "";
  let capturedBody: unknown = null;
  let capturedAuth = "";
  const restore = fakeFetch((url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    return new Response(JSON.stringify({ full_name: "octocat/new-repo", clone_url: "https://github.com/octocat/new-repo.git", html_url: "https://github.com/octocat/new-repo" }), { status: 201 });
  });
  try {
    const result = await tool.execute({ name: "new-repo", private: true }, ctx);
    check("POSTs to /user/repos", capturedUrl === "https://api.github.com/user/repos");
    check("sends the requested name and visibility", (capturedBody as any).name === "new-repo" && (capturedBody as any).private === true);
    check("sends the token as a Bearer header", capturedAuth === "Bearer gho_faketoken");
    check("succeeds", result.ok === true);
    check("returns the clone URL", (result.output as any).cloneUrl === "https://github.com/octocat/new-repo.git");
  } finally {
    restore();
  }
}
{
  const tool = createGithubCreateRepoTool(async () => "gho_faketoken");
  const restore = fakeFetch(() => new Response(JSON.stringify({ message: "name already exists on this account" }), { status: 422 }));
  try {
    const result = await tool.execute({ name: "taken", private: false }, ctx);
    check("surfaces the 422 message as the tool error, not a crash", result.ok === false && String(result.error).includes("already exists"));
  } finally {
    restore();
  }
}
{
  const tool = createGithubCreateRepoTool(async () => null);
  const result = await tool.execute({ name: "x", private: false }, ctx);
  check("fails clearly when no account is connected", result.ok === false && String(result.error).toLowerCase().includes("connect"));
}
{
  // Spec's error-handling section calls this out explicitly: a token
  // revoked on GitHub's side after connecting must surface as an ordinary
  // tool error, not a crash — same code path as the 422 case above, but
  // worth its own named check since the spec names 401 specifically.
  const tool = createGithubCreateRepoTool(async () => "gho_revoked");
  const restore = fakeFetch(() => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
  try {
    const result = await tool.execute({ name: "x", private: false }, ctx);
    check("a revoked token (401) surfaces as a tool error, not a crash", result.ok === false && String(result.error).includes("Bad credentials"));
  } finally {
    restore();
  }
}
{
  // Correctness audit finding (GitHub Medium #2): without this, nothing
  // ever told the stored identity it had gone bad — Settings kept showing
  // "Connected as @x" indefinitely after a real revocation, with every
  // actual use of the integration failing and no path back to "reconnect
  // your account" short of the user noticing on their own.
  let unauthorizedCalls = 0;
  const tool = createGithubCreateRepoTool(async () => "gho_revoked", async () => {
    unauthorizedCalls++;
  });
  const restore = fakeFetch(() => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
  try {
    await tool.execute({ name: "x", private: false }, ctx);
    check("a 401 invokes the onUnauthorized callback exactly once, so the stored identity can be cleared", unauthorizedCalls === 1);
  } finally {
    restore();
  }
}
{
  // A non-401 error (the existing 422 case) must NOT trigger it — the
  // token itself is still fine in that case.
  let unauthorizedCalls = 0;
  const tool = createGithubCreateRepoTool(async () => "gho_faketoken", async () => {
    unauthorizedCalls++;
  });
  const restore = fakeFetch(() => new Response(JSON.stringify({ message: "already exists" }), { status: 422 }));
  try {
    await tool.execute({ name: "x", private: false }, ctx);
    check("a 422 (not a token problem) never invokes onUnauthorized", unauthorizedCalls === 0);
  } finally {
    restore();
  }
}

{
  // Important #6 from final review: owner/repo/org flow unvalidated
  // straight into the URL path. Something like "o/r/issues/1/comments"
  // would make a github_create_pr call actually POST to a completely
  // different, real endpoint (adding an issue comment) while the approval
  // prompt still says "github_create_pr" — misleading the user about what
  // they approved. Reject anything outside GitHub's own real
  // owner/repo-name character set outright, before ever building a path.
  const tool = createGithubCreateRepoTool(async () => "gho_faketoken");
  let fetchWasCalled = false;
  const restore = fakeFetch(() => {
    fetchWasCalled = true;
    return new Response(JSON.stringify({}), { status: 201 });
  });
  try {
    const result = await tool.execute({ name: "x", private: false, org: "o/r/issues/1/comments?x=" }, ctx);
    check("rejects an org value containing a path separator without ever making the request", result.ok === false && !fetchWasCalled);
  } finally {
    restore();
  }
}

console.log("\ngithub_create_pr:");
{
  const tool = createGithubCreatePrTool(async () => "gho_faketoken");
  check("declares NETWORK permission (Global Constraint: always ASK)", tool.permission === "NETWORK");

  let capturedUrl = "";
  let capturedBody: unknown = null;
  const restore = fakeFetch((url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ html_url: "https://github.com/octocat/repo/pull/1", number: 1 }), { status: 201 });
  });
  try {
    const result = await tool.execute({ owner: "octocat", repo: "repo", base: "main", head: "feature", title: "My PR", body: "Description" }, ctx);
    check("POSTs to /repos/{owner}/{repo}/pulls", capturedUrl === "https://api.github.com/repos/octocat/repo/pulls");
    check("sends base/head/title/body", (capturedBody as any).base === "main" && (capturedBody as any).head === "feature" && (capturedBody as any).title === "My PR");
    check("returns the PR URL", result.ok === true && (result.output as any).url === "https://github.com/octocat/repo/pull/1");
  } finally {
    restore();
  }
}
{
  const tool = createGithubCreatePrTool(async () => null);
  const result = await tool.execute({ owner: "o", repo: "r", base: "main", head: "feature", title: "t", body: "" }, ctx);
  check("fails clearly when no account is connected", result.ok === false && String(result.error).toLowerCase().includes("connect"));
}
{
  const tool = createGithubCreatePrTool(async () => "gho_faketoken");
  const restore = fakeFetch(() => new Response(JSON.stringify({ message: "A pull request already exists for octocat:feature." }), { status: 422 }));
  try {
    const result = await tool.execute({ owner: "octocat", repo: "repo", base: "main", head: "feature", title: "t", body: "" }, ctx);
    check("surfaces a 422 message verbatim", result.ok === false && String(result.error).includes("already exists"));
  } finally {
    restore();
  }
}
{
  const tool = createGithubCreatePrTool(async () => "gho_faketoken");
  let fetchWasCalled = false;
  const restore = fakeFetch(() => {
    fetchWasCalled = true;
    return new Response(JSON.stringify({}), { status: 201 });
  });
  try {
    const result = await tool.execute({ owner: "o", repo: "r/issues/1/comments?x=", base: "main", head: "feature", title: "t", body: "" }, ctx);
    check("rejects a repo value that would redirect the request to a different real endpoint, without ever making it", result.ok === false && !fetchWasCalled);
  } finally {
    restore();
  }
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
