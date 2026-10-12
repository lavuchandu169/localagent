import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSkillFrontmatter,
  matchSkills,
  MAX_SKILLS_PER_TASK,
  discoverSkillsIn,
  discoverBuiltinSkills,
  discoverUserSkills,
  type SkillMetadata,
} from "../../skillLoader.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("parseSkillFrontmatter:");
{
  const raw = `---
name: debug-flaky-test
description: Use when a test fails intermittently, not every run.
triggers: [flaky, intermittent, "fails sometimes", nondeterministic]
---
Body text here.
More body text.
`;
  const result = parseSkillFrontmatter(raw);
  check("parses a valid skill file", result.ok === true);
  if (result.ok) {
    check("extracts name", result.name === "debug-flaky-test");
    check("extracts description", result.description === "Use when a test fails intermittently, not every run.");
    check(
      "extracts triggers, stripping quotes from quoted entries and trimming whitespace",
      JSON.stringify(result.triggers) === JSON.stringify(["flaky", "intermittent", "fails sometimes", "nondeterministic"])
    );
    check("extracts the body, trimmed", result.body === "Body text here.\nMore body text.");
  }
}
{
  const result = parseSkillFrontmatter("no frontmatter block at all, just text");
  check("a file with no --- frontmatter block fails with a clear error", result.ok === false && result.error.includes("frontmatter"));
}
{
  const raw = `---
description: missing a name field
triggers: [x]
---
body
`;
  const result = parseSkillFrontmatter(raw);
  check("missing required field 'name' fails with a clear error", result.ok === false && result.error.includes("name"));
}
{
  const raw = `---
name: x
triggers: [x]
---
body
`;
  const result = parseSkillFrontmatter(raw);
  check("missing required field 'description' fails with a clear error", result.ok === false && result.error.includes("description"));
}
{
  const raw = `---
name: x
description: y
---
body
`;
  const result = parseSkillFrontmatter(raw);
  check("missing required field 'triggers' fails with a clear error", result.ok === false && result.error.includes("triggers"));
}
{
  const raw = `---
name: x
description: y
triggers: not-a-bracketed-list
---
body
`;
  const result = parseSkillFrontmatter(raw);
  check("triggers that isn't a bracketed [a, b] list fails with a clear error", result.ok === false && result.error.includes("triggers"));
}
{
  const raw = `---
name: x
description: y
triggers: []
---
body
`;
  const result = parseSkillFrontmatter(raw);
  check("an empty triggers list fails with a clear error (a skill with no triggers can never match anything)", result.ok === false);
}
{
  const raw = `---
name: x
description: y
triggers: [ a ,  b  ]
---
body
`;
  const result = parseSkillFrontmatter(raw);
  check(
    "whitespace around unquoted trigger entries is trimmed",
    result.ok === true && JSON.stringify(result.triggers) === JSON.stringify(["a", "b"])
  );
}

console.log("\nmatchSkills:");
{
  const skills: SkillMetadata[] = [
    { id: "a", name: "A", description: "", triggers: ["flaky", "intermittent"], body: "", source: "builtin" },
    { id: "b", name: "B", description: "", triggers: ["release", "changelog"], body: "", source: "user" },
  ];
  check(
    "matches a skill whose trigger appears as a case-insensitive substring of the task",
    JSON.stringify(matchSkills("this test is FLAKY sometimes", skills, new Set()).map((s) => s.id)) === JSON.stringify(["a"])
  );
  check(
    "a task matching no skill's triggers returns no matches",
    matchSkills("please add a login button", skills, new Set()).length === 0
  );
  check(
    "a task matching more than one skill returns all of them, in input order",
    JSON.stringify(matchSkills("flaky test, also update the changelog", skills, new Set()).map((s) => s.id)) ===
      JSON.stringify(["a", "b"])
  );
  check(
    "a skill already in alreadyLoaded is never returned again, even if its trigger matches",
    matchSkills("flaky test again", skills, new Set(["a"])).length === 0
  );
  check(
    "matching on ANY one of several triggers is enough — the whole array doesn't need to match",
    matchSkills("the changelog needs an update", skills, new Set()).map((s) => s.id).includes("b")
  );
}

console.log(`\nMAX_SKILLS_PER_TASK is a small, sane fixed cap (sanity check, not a design decision this test makes):`);
check("MAX_SKILLS_PER_TASK is 3", MAX_SKILLS_PER_TASK === 3);

console.log("\ndiscoverSkillsIn (against disposable temp directories):");
await (async () => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "localagent-skills-test-"));
  try {
    // A valid skill with a references/ file.
    const validDir = path.join(tmpRoot, "valid-skill");
    await fsPromises.mkdir(path.join(validDir, "references"), { recursive: true });
    await fsPromises.writeFile(
      path.join(validDir, "SKILL.md"),
      `---\nname: Valid Skill\ndescription: a real one\ntriggers: [valid]\n---\nMain body.`
    );
    await fsPromises.writeFile(path.join(validDir, "references", "extra.md"), "Extra reference content.");

    // A malformed skill (missing required field) sitting right alongside it.
    const brokenDir = path.join(tmpRoot, "broken-skill");
    await fsPromises.mkdir(brokenDir, { recursive: true });
    await fsPromises.writeFile(path.join(brokenDir, "SKILL.md"), `---\nname: Broken\n---\nno description or triggers`);

    // A directory whose name doesn't match the allowed id pattern.
    const badIdDir = path.join(tmpRoot, "Not_A_Valid_Id!");
    await fsPromises.mkdir(badIdDir, { recursive: true });
    await fsPromises.writeFile(path.join(badIdDir, "SKILL.md"), `---\nname: x\ndescription: y\ntriggers: [z]\n---\nbody`);

    // A stray non-directory file sitting directly in the root.
    // Named to PASS the SKILL_ID_PATTERN check (no dot, all lowercase/hyphen)
    // deliberately — a stray file whose name would ALSO fail the id-pattern
    // check doesn't independently prove the isDirectory() filter does
    // anything (mutation-tested: confirmed live that a dotted name like
    // "stray-file.txt" lets a broken isDirectory() check slip through
    // undetected, since the id-pattern check happens to reject it too).
    await fsPromises.writeFile(path.join(tmpRoot, "stray-not-a-directory"), "not a skill directory");

    const withReferences = await discoverSkillsIn(tmpRoot, "user", true);
    check("discovers exactly the one valid skill (broken, bad-id, and stray-file are all skipped)", withReferences.length === 1);
    check("the discovered skill has the right id (from the directory name)", withReferences[0]?.id === "valid-skill");
    check("inlineReferences=true appends the references/ file's content into body", withReferences[0]?.body.includes("Extra reference content.") === true);

    const withoutReferences = await discoverSkillsIn(tmpRoot, "user", false);
    check(
      "inlineReferences=false leaves references/ content OUT of body",
      withoutReferences[0]?.body.includes("Main body.") === true && withoutReferences[0]?.body.includes("Extra reference content.") !== true
    );

    check("a nonexistent root directory returns an empty list, not an error", (await discoverSkillsIn(path.join(tmpRoot, "does-not-exist"), "user", false)).length === 0);
  } finally {
    await fsPromises.rm(tmpRoot, { recursive: true, force: true });
  }
})();

console.log("\ndiscoverBuiltinSkills (against the real shipped content):");
{
  const builtin = await discoverBuiltinSkills();
  const flaky = builtin.find((s) => s.id === "debug-flaky-test");
  check("finds the real shipped debug-flaky-test skill", flaky !== undefined);
  check("its source is 'builtin'", flaky?.source === "builtin");
  check("its triggers include 'flaky'", flaky?.triggers.includes("flaky") === true);
  check("its body eagerly inlines the references/common-causes.md content", flaky?.body.includes("Shared mutable state between tests") === true);
}

console.log("\ndiscoverUserSkills (against a disposable temp workspace):");
await (async () => {
  const workspaceRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "localagent-skills-workspace-test-"));
  try {
    const skillDir = path.join(workspaceRoot, ".localagent", "skills", "my-project-skill");
    await fsPromises.mkdir(skillDir, { recursive: true });
    await fsPromises.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: Mine\ndescription: project-specific\ntriggers: [mykeyword]\n---\nProject body.`);

    const found = await discoverUserSkills(workspaceRoot);
    check("finds the user-authored skill under .localagent/skills", found.length === 1 && found[0]?.id === "my-project-skill");
    check("its source is 'user'", found[0]?.source === "user");
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
  }
})();
await (async () => {
  const workspaceRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "localagent-skills-no-dir-test-"));
  try {
    const found = await discoverUserSkills(workspaceRoot);
    check("a workspace with no .localagent/skills directory at all (the common case) returns an empty list, no error", found.length === 0);
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
  }
})();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
