import { loadSkillTool } from "../../tools/loadSkill.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("loadSkillTool:");
{
  check("is named load_skill — the exact name autoLoadSkills' synthetic tool_calls already use", loadSkillTool.name === "load_skill");
  check("is a READ tool — calling it does nothing consequential, so it never needs approval", loadSkillTool.permission === "READ");
}
{
  const result = await loadSkillTool.execute({}, { workspaceRoot: "/does/not/matter", log: () => {} });
  check("calling it directly succeeds rather than erroring", result.ok === true);
  check(
    "its response tells the model skills already load automatically, so it doesn't keep retrying",
    typeof result.output === "object" && result.output !== null && "message" in result.output && String((result.output as any).message).includes("automatically")
  );
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
