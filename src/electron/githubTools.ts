// src/electron/githubTools.ts
import type { Tool, ToolContext, ToolResult } from "../types.js";

type GetToken = () => Promise<string | null>;

const NOT_CONNECTED_ERROR = "No GitHub account is connected — connect one in Settings first.";

// GitHub's own real username/org/repo-name character set (letters, digits,
// hyphens, underscores, dots) — anything outside this can only be an
// attempt (deliberate or accidental) to redirect the request to a
// different API path than the one the approval prompt named. Validated
// before any path is built, not just percent-encoded, so a malformed
// value is rejected outright rather than silently mangled into some other
// still-technically-valid path.
const VALID_GITHUB_IDENTIFIER = /^[A-Za-z0-9_.-]+$/;

function validateGithubIdentifier(value: string, fieldName: string): string | null {
  if (!VALID_GITHUB_IDENTIFIER.test(value)) {
    return `Invalid ${fieldName} "${value}" — GitHub owner/repo/org names may only contain letters, digits, hyphens, underscores, and dots.`;
  }
  return null;
}

async function githubApiRequest<T>(getToken: GetToken, method: string, path: string, body?: unknown): Promise<ToolResult<T>> {
  const token = await getToken();
  if (!token) return { ok: false, output: null, error: NOT_CONNECTED_ERROR };
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof (data as any)?.message === "string" ? (data as any).message : `GitHub API request failed: ${response.status} ${response.statusText}`;
    return { ok: false, output: null, error: message };
  }
  return { ok: true, output: data as T };
}

interface CreateRepoInput {
  name: string;
  private: boolean;
  org?: string;
}

interface CreateRepoOutput {
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
}

export function createGithubCreateRepoTool(getToken: GetToken): Tool<CreateRepoInput, CreateRepoOutput> {
  return {
    name: "github_create_repo",
    description: "Creates a new GitHub repository under the connected account (or an org, if specified). Requires a connected GitHub account.",
    permission: "NETWORK",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        private: { type: "boolean" },
        org: { type: "string", description: "Optional organization to create the repo under, instead of the connected user's own account." },
      },
      required: ["name", "private"],
    },
    async execute(input: CreateRepoInput, _ctx: ToolContext): Promise<ToolResult<CreateRepoOutput>> {
      if (input.org) {
        const invalid = validateGithubIdentifier(input.org, "org");
        if (invalid) return { ok: false, output: null, error: invalid };
      }
      const path = input.org ? `/orgs/${encodeURIComponent(input.org)}/repos` : "/user/repos";
      const result = await githubApiRequest<{ full_name: string; clone_url: string; html_url: string }>(getToken, "POST", path, {
        name: input.name,
        private: input.private,
      });
      if (!result.ok || !result.output) return result as unknown as ToolResult<CreateRepoOutput>;
      return {
        ok: true,
        output: { fullName: result.output.full_name, cloneUrl: result.output.clone_url, htmlUrl: result.output.html_url },
      };
    },
  };
}

interface CreatePrInput {
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

interface CreatePrOutput {
  url: string;
  number: number;
}

export function createGithubCreatePrTool(getToken: GetToken): Tool<CreatePrInput, CreatePrOutput> {
  return {
    name: "github_create_pr",
    description: "Opens a pull request on GitHub from an already-pushed head branch against a base branch. Requires a connected GitHub account.",
    permission: "NETWORK",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        base: { type: "string", description: "The branch to merge into, e.g. main." },
        head: { type: "string", description: "The already-pushed branch to merge from." },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "base", "head", "title", "body"],
    },
    async execute(input: CreatePrInput, _ctx: ToolContext): Promise<ToolResult<CreatePrOutput>> {
      const invalidOwner = validateGithubIdentifier(input.owner, "owner");
      if (invalidOwner) return { ok: false, output: null, error: invalidOwner };
      const invalidRepo = validateGithubIdentifier(input.repo, "repo");
      if (invalidRepo) return { ok: false, output: null, error: invalidRepo };
      const result = await githubApiRequest<{ html_url: string; number: number }>(getToken, "POST", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`, {
        base: input.base,
        head: input.head,
        title: input.title,
        body: input.body,
      });
      if (!result.ok || !result.output) return result as unknown as ToolResult<CreatePrOutput>;
      return { ok: true, output: { url: result.output.html_url, number: result.output.number } };
    },
  };
}
