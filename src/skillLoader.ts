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
