// Pure Organization data model and in-memory helpers — deliberately zero
// Node dependency (no "node:fs"/"node:path") because this module is
// reachable from renderer code (src/electron/renderer/organizationPanel.ts),
// which loads as a native browser ES module with no bundler: any runtime
// import of a Node builtin anywhere in that module graph breaks the whole
// graph (see rendererModuleGraph.test.ts). organization.ts re-exports all
// of this for its existing Node-side importers (main.ts,
// organizationSession.ts) plus the disk-backed loadOrganization/
// saveOrganization that do need fs/path.
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
 * the caller already knows which initiative it just ran; there's nothing a
 * thrown error would protect against here that the no-op doesn't already
 * handle safely.
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
