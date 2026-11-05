import { promises as fs } from "node:fs";
import path from "node:path";
import { emptyOrganization, type Organization } from "./organizationTask.js";

// Re-exports the pure data model and helpers for this module's existing
// importers (main.ts, organizationSession.ts, tests) — see
// organizationTask.ts for why they live in their own Node-free module.
export * from "./organizationTask.js";

function orgFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".localagent", "organization.json");
}

/** Narrow, defensive validation of untrusted JSON read off disk — not a
 * full schema validator, just enough to refuse a shape that would crash
 * or silently misbehave later (a non-array `roles`/`initiatives`, a
 * non-string `goal`). A field-level shape mismatch inside an array entry
 * is NOT deep-validated; this matches this app's established "file on
 * disk is a workspace artifact a user can hand-edit" posture (same spirit
 * as parseSkillFrontmatter never type-checking beyond its own flat
 * fields) rather than trying to be a strict schema enforcer.
 */
function isPlausibleOrganization(value: unknown): value is Organization {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.goal === "string" && Array.isArray(v.roles) && Array.isArray(v.initiatives);
}

/**
 * Never throws: a missing file (the common case — most workspaces have
 * no organization yet) or a malformed/wrong-shaped one both degrade to
 * emptyOrganization(), matching this app's established "workspace-config
 * loader never throws" contract (see skillLoader.ts's discoverSkillsIn).
 * A malformed file is distinguished from a missing one only to decide
 * whether to log — ENOENT is silent, anything else gets a warning so a
 * genuinely broken file doesn't fail invisibly.
 */
export async function loadOrganization(workspaceRoot: string): Promise<Organization> {
  let raw: string;
  try {
    raw = await fs.readFile(orgFilePath(workspaceRoot), "utf8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[organization] could not read organization.json: ${err?.message ?? err}`);
    }
    return emptyOrganization();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    console.warn(`[organization] organization.json is not valid JSON: ${err?.message ?? err}`);
    return emptyOrganization();
  }

  if (!isPlausibleOrganization(parsed)) {
    console.warn("[organization] organization.json has an unexpected shape — ignoring it");
    return emptyOrganization();
  }
  return parsed;
}

/**
 * Writes via a temp-file-then-rename so a crash or power loss mid-write
 * can never leave organization.json half-written — `rename` on the same
 * filesystem is atomic, unlike writing the target path directly. Creates
 * `.localagent/` if it doesn't exist yet (saveOrganization is the first
 * write-side operation in this area; skillLoader, read-only, never
 * needed to). Returns a result rather than throwing, matching this
 * app's ToolResult-shaped error convention, since a caller (the
 * Organization UI) needs to show a write failure to the user rather than
 * crash a session over it.
 */
export async function saveOrganization(workspaceRoot: string, org: Organization): Promise<{ ok: true } | { ok: false; error: string }> {
  const dir = path.join(workspaceRoot, ".localagent");
  const target = orgFilePath(workspaceRoot);
  const tmp = path.join(dir, `.organization.json.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(org, null, 2), "utf8");
    await fs.rename(tmp, target);
    return { ok: true };
  } catch (err: any) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return { ok: false, error: err?.message ?? String(err) };
  }
}
