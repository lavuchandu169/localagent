import { promises as fs } from "node:fs";
import path from "node:path";

export interface Role {
  id: string;
  /** "CEO", "CTO", "Engineer", "Designer", "Marketer", or any custom title. */
  title: string;
  responsibilities: string;
  /** Another role's id, or null for the top of the org (e.g. the CEO). */
  reportsTo: string | null;
  /** Which model this role runs as — the same model id strings already
   * used elsewhere in the app (embedded model ids, cloud model ids, or
   * "freellmapi-auto"). Not validated here; an unknown id is a session-
   * start-time concern, not a data-model concern. */
  model: string;
}

export type InitiativeStatus = "todo" | "in-progress" | "done";

export interface Initiative {
  id: string;
  title: string;
  /** Which role owns this initiative, or null if unassigned. */
  assignedRoleId: string | null;
  status: InitiativeStatus;
  /** Freeform progress/handoff notes, appended over time. */
  notes: string;
}

export interface Organization {
  /** The company's stated goal, in the user's own words. */
  goal: string;
  roles: Role[];
  initiatives: Initiative[];
}

export function emptyOrganization(): Organization {
  return { goal: "", roles: [], initiatives: [] };
}

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
 * Organization UI, once built) needs to show a write failure to the
 * user rather than crash a session over it.
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

export function findRole(org: Organization, roleId: string): Role | undefined {
  return org.roles.find((r) => r.id === roleId);
}

export function initiativesForRole(org: Organization, roleId: string): Initiative[] {
  return org.initiatives.filter((i) => i.assignedRoleId === roleId);
}

/**
 * Pure functional update: returns a NEW Organization with one initiative
 * patched, leaving the input untouched. An unknown initiativeId is a
 * harmless no-op (returns an equivalent object) rather than an error —
 * the caller (the session-wiring slice, once built) already knows which
 * initiative it just ran; there's nothing a thrown error would protect
 * against here that the no-op doesn't already handle safely.
 */
export function updateInitiative(org: Organization, initiativeId: string, patch: Partial<Pick<Initiative, "status" | "notes" | "assignedRoleId">>): Organization {
  let changed = false;
  const initiatives = org.initiatives.map((i) => {
    if (i.id !== initiativeId) return i;
    changed = true;
    return { ...i, ...patch };
  });
  if (!changed) return org;
  return { ...org, initiatives };
}

/**
 * Composes the real task text an initiative's assigned role gets started
 * with — the actual hand-off point into a normal session once the
 * session-wiring slice exists. Deliberately plain text, not a structured
 * prompt-injection-prone template: the role's own `responsibilities` and
 * the initiative's own `notes` are workspace-authored content the user
 * controls (same trust level as any other file in their own project),
 * not external/untrusted input.
 */
export function buildInitiativeTask(org: Organization, initiative: Initiative, role: Role): string {
  const lines: string[] = [`You are acting as ${role.title} in this organization.`];
  if (role.responsibilities) lines.push(`Your responsibilities: ${role.responsibilities}`);
  if (org.goal) lines.push(`The organization's goal: ${org.goal}`);
  lines.push(`Your task: ${initiative.title}`);
  if (initiative.notes) lines.push(`Notes/handoff from prior work: ${initiative.notes}`);
  return lines.join("\n\n");
}
