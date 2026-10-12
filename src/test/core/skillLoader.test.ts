import { parseSkillFrontmatter, matchSkills, MAX_SKILLS_PER_TASK, type SkillMetadata } from "../../skillLoader.js";

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

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
