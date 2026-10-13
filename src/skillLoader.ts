import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A trigger shorter than this is dropped into the "fails outright"
 * bucket (deferred-minor finding): a 1-2 character trigger matches
 * almost every task as a plain substring, which is an easy accident for
 * an honest skill author to make, not just a theoretical abuse case —
 * rejecting it outright at parse time makes the problem visible
 * immediately instead of silently over-firing. */
const MIN_TRIGGER_LENGTH = 3;

/** Splits a bracketed trigger-list's inner text on commas, except for
 * commas that appear INSIDE a quoted entry (deferred-minor finding: the
 * previous plain `.split(",")` incorrectly split a trigger like
 * `"fails, sometimes"` into two separate triggers at the comma that was
 * part of its own quoted text). Tracks quote state char-by-char rather
 * than using a regex, since the quote character itself (' or ") can
 * differ per entry and nesting isn't a concern for this narrow schema. */
function splitTriggerList(inner: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoteChar: string | null = null;
  for (const ch of inner) {
    if (quoteChar) {
      current += ch;
      if (ch === quoteChar) quoteChar = null;
    } else if (ch === '"' || ch === "'") {
      quoteChar = ch;
      current += ch;
    } else if (ch === ",") {
      tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  tokens.push(current);
  return tokens;
}

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
  // Deferred-minor finding: a leading UTF-8 BOM (some Windows editors
  // add one automatically) would otherwise make an entirely valid file
  // look like it has no frontmatter block at all, since a BOM character
  // immediately followed by three dashes doesn't match a regex anchored
  // on a literal "---" at position 0.
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(withoutBom);
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
  const triggers = splitTriggerList(bracketMatch[1]!)
    .map((t) => t.trim().replace(/^["']|["']$/g, "").trim())
    .filter((t) => t.length > 0);
  if (triggers.length === 0) {
    return { ok: false, error: "triggers must be a non-empty list" };
  }
  const tooShort = triggers.find((t) => t.length < MIN_TRIGGER_LENGTH);
  if (tooShort) {
    return {
      ok: false,
      error: `trigger "${tooShort}" is too short (minimum ${MIN_TRIGGER_LENGTH} characters) — a very short trigger matches almost every task`,
    };
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_ROOT = path.join(__dirname, "skills", "builtin");

/** Skill directory names must be this shape — matches this app's other
 * id-like identifiers (e.g. EmbeddedModelId's own values). Guards
 * against a stray non-skill directory (an editor swap folder, a `.git`
 * if someone ever points this at a weird root) being misread as a
 * skill with a confusing id. */
const SKILL_ID_PATTERN = /^[a-z0-9-]+$/;

async function readSkillDirectory(dir: string, source: "builtin" | "user", inlineReferences: boolean): Promise<SkillMetadata | null> {
  const id = path.basename(dir);
  if (!SKILL_ID_PATTERN.test(id)) {
    console.warn(`[skills] skipping "${id}": skill directory names must match ${SKILL_ID_PATTERN}`);
    return null;
  }
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
  } catch (err: any) {
    console.warn(`[skills] skipping "${id}": could not read SKILL.md (${err.message})`);
    return null;
  }
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed.ok) {
    console.warn(`[skills] skipping "${id}": ${parsed.error}`);
    return null;
  }

  let body = parsed.body;
  if (inlineReferences) {
    const referencesDir = path.join(dir, "references");
    try {
      const files = (await fs.readdir(referencesDir)).filter((f) => f.endsWith(".md")).sort();
      for (const file of files) {
        const refContent = await fs.readFile(path.join(referencesDir, file), "utf8");
        body += `\n\n---\n# ${file}\n\n${refContent.trim()}`;
      }
    } catch {
      // No references/ directory at all — fine, most skills won't have one.
    }
  }

  return { id, name: parsed.name, description: parsed.description, triggers: parsed.triggers, body, source };
}

/**
 * Lists every immediate subdirectory of `root`, treats each as one
 * candidate skill, and parses it. Never throws: a missing root (the
 * overwhelmingly common case for `.localagent/skills` — most projects
 * won't have one) just means no skills, not an error. A malformed or
 * unreadable individual skill is skipped with a logged warning, never
 * blocking its siblings.
 */
export async function discoverSkillsIn(root: string, source: "builtin" | "user", inlineReferences: boolean): Promise<SkillMetadata[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err: any) {
    // Deferred-minor finding M4: a missing root (the overwhelmingly
    // common case — most projects have no .localagent/skills at all)
    // must stay silent, but any OTHER readdir failure (a permissions
    // error, the path existing as a file instead of a directory) was
    // previously swallowed exactly the same way, with no trace at all
    // that something was actually wrong versus just "nothing here yet."
    if (err?.code !== "ENOENT") {
      console.warn(`[skills] could not list "${root}": ${err?.message ?? err}`);
    }
    return [];
  }
  // Final-review finding I3: raw readdir order reflects filesystem
  // internals (hash/creation order on APFS/ext4), not lexical order —
  // without sorting, "which skills win under MAX_SKILLS_PER_TASK" could
  // differ between machines or checkouts even for the identical set of
  // skill directories, undermining the "predictable, reason-about-able"
  // matching the design spec promises.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const results: SkillMetadata[] = [];
  for (const entry of entries) {
    // Deferred-minor finding M3: a symlinked skill directory was already
    // excluded (isDirectory() on a Dirent is false for a symlink, even
    // one pointing at a real directory, unless the symlink is followed
    // first) but silently — no trace that a skill the user set up (e.g.
    // `ln -s ~/dotfiles/skills/foo .localagent/skills/foo`) was actually
    // seen and skipped, versus never having been there at all. Resolving
    // it was deliberately NOT done here (a symlink could point outside
    // the workspace — same containment question flagged for user-skill
    // reads generally; see the design spec/final-review notes) — this
    // only makes the skip visible, it doesn't change what's followed.
    if (entry.isSymbolicLink()) {
      console.warn(`[skills] skipping "${entry.name}": symlinked skill directories are not supported`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const metadata = await readSkillDirectory(path.join(root, entry.name), source, inlineReferences);
    if (metadata) results.push(metadata);
  }
  return results;
}

let builtinSkillsCache: Promise<SkillMetadata[]> | null = null;

/** Built-in skills are bundled with the app and can't change at
 * runtime, so this is computed once per process and reused — unlike
 * discoverUserSkills, which deliberately re-reads fresh every call. */
export function discoverBuiltinSkills(): Promise<SkillMetadata[]> {
  if (!builtinSkillsCache) builtinSkillsCache = discoverSkillsIn(BUILTIN_SKILLS_ROOT, "builtin", true);
  return builtinSkillsCache;
}

/** Deliberately not cached — re-read fresh on every call so a skill
 * file the user just added or edited is picked up on the very next
 * task, with no restart and no cache-invalidation logic needed. */
export function discoverUserSkills(workspaceRoot: string): Promise<SkillMetadata[]> {
  return discoverSkillsIn(path.join(workspaceRoot, ".localagent", "skills"), "user", false);
}
