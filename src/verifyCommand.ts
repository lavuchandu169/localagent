import fs from "node:fs/promises";
import path from "node:path";

/**
 * Detects the project's own test/verify command from common project-root
 * markers — package.json's real "test" script, pytest, cargo, or go. First
 * match wins; returns null if nothing recognizable is found, which the
 * caller (agent.ts's auto-verify step) treats as a silent no-op — no
 * verification attempted, same as today. Checked at the workspace root
 * only, no nested/monorepo package scanning.
 */
export async function detectVerifyCommand(workspaceRoot: string): Promise<string | null> {
  const pkg = await readJson(path.join(workspaceRoot, "package.json"));
  const testScript = pkg?.scripts?.test;
  // npm init's own default placeholder script — never actually runs tests.
  if (typeof testScript === "string" && testScript.trim() && !testScript.includes("Error: no test specified")) {
    return "npm test";
  }

  if (await fileExists(path.join(workspaceRoot, "pytest.ini"))) return "pytest";
  const pyproject = await readText(path.join(workspaceRoot, "pyproject.toml"));
  if (pyproject && /\[tool\.pytest\b/.test(pyproject)) return "pytest";
  if (await hasMatchingFile(workspaceRoot, /^(test_.*|.*_test)\.py$/)) return "pytest";

  if (await fileExists(path.join(workspaceRoot, "Cargo.toml"))) return "cargo test";
  if (await fileExists(path.join(workspaceRoot, "go.mod"))) return "go test ./...";

  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

async function readJson(p: string): Promise<any | null> {
  const text = await readText(p);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function hasMatchingFile(dir: string, pattern: RegExp): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.some((name) => pattern.test(name));
  } catch {
    return false;
  }
}
