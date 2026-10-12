/**
 * Parses one SKILL.md file's raw text into its frontmatter fields plus
 * body. Hand-rolled rather than a YAML library, deliberately — the
 * schema is a narrow, fixed, documented shape (3 flat fields, one of
 * which is a flow-style bracketed list), not general YAML. Never
 * throws: a malformed file produces a typed error the caller logs and
 * skips, matching this app's established "settings loader never
 * throws" contract (see mcpSettings.ts et al.).
 */
export function parseSkillFrontmatter(
  raw: string
): { ok: true; name: string; description: string; triggers: string[]; body: string } | { ok: false; error: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    return { ok: false, error: "missing --- frontmatter block" };
  }
  const [, frontmatter, body] = match as unknown as [string, string, string];

  const fields: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      return { ok: false, error: `malformed frontmatter line (expected "key: value"): ${line}` };
    }
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    fields[key] = value;
  }

  const name = fields.name;
  if (!name) return { ok: false, error: "missing required field: name" };
  const description = fields.description;
  if (!description) return { ok: false, error: "missing required field: description" };
  const triggersRaw = fields.triggers;
  if (!triggersRaw) return { ok: false, error: "missing required field: triggers" };

  const bracketMatch = /^\[([\s\S]*)\]$/.exec(triggersRaw);
  if (!bracketMatch) {
    return { ok: false, error: `triggers must be a bracketed list, e.g. [a, b]: got "${triggersRaw}"` };
  }
  const triggers = bracketMatch[1]!
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, "").trim())
    .filter((t) => t.length > 0);
  if (triggers.length === 0) {
    return { ok: false, error: "triggers must be a non-empty list" };
  }

  return { ok: true, name, description, triggers, body: body.trim() };
}

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  body: string;
  /** Where this skill was discovered from — "builtin" skills eagerly
   * inline their references/ files into `body` at discovery time;
   * "user" skills don't (the model reads them later, lazily, via its
   * own existing read_file tool, since they live inside the workspace
   * already). See the design spec's "Reference-file access" section. */
  source: "builtin" | "user";
}

/** The most skills a single task will ever have injected, regardless of
 * how many actually match — matching more doesn't mean injecting more;
 * see agent.ts's autoLoadSkills for the cap-and-warn behavior this
 * constant gates. Deliberately small and fixed: a task matching many
 * skills is more likely an overly-generic trigger word than a genuine
 * need for that much injected context at once. */
export const MAX_SKILLS_PER_TASK = 3;

/**
 * Deterministic, keyword-only matching — no model/LLM call, no
 * semantic fuzziness. Case-insensitive substring match against the
 * task text, same matching shape extractFilenameCandidates already
 * uses for filenames: simple enough that a skill author (or a weak
 * local model reading the injected result) can reason about exactly
 * when a skill fires, with no surprises. Returns every match, in
 * `skills`' own order, uncapped — capping is the caller's job (it needs
 * to log what got skipped, a side effect this pure function shouldn't
 * have).
 */
export function matchSkills(task: string, skills: SkillMetadata[], alreadyLoaded: ReadonlySet<string>): SkillMetadata[] {
  const lowerTask = task.toLowerCase();
  return skills.filter((skill) => {
    if (alreadyLoaded.has(skill.id)) return false;
    return skill.triggers.some((trigger) => lowerTask.includes(trigger.toLowerCase()));
  });
}
