import { LOAD_SKILL_FALLBACK_MESSAGE } from "../../tools/loadSkill.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("LOAD_SKILL_FALLBACK_MESSAGE:");
check(
  "tells the model skills already load automatically, so it doesn't keep retrying or treat this as a real action",
  LOAD_SKILL_FALLBACK_MESSAGE.includes("automatically")
);

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
