import { MODE_LABELS } from "../electron/modeLabels.js";
import type { PermissionMode } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("Mode labels:");

const modes: PermissionMode[] = ["PLAN", "DEFAULT", "ACCEPT_EDITS", "AUTO_SAFE"];

check(
  "every PermissionMode has a non-empty label and description",
  modes.every((m) => MODE_LABELS[m].label.trim().length > 0 && MODE_LABELS[m].description.trim().length > 0)
);

check("DEFAULT's label doesn't use the internal mode name as user-facing copy", MODE_LABELS.DEFAULT.label !== "DEFAULT");

check("PLAN's copy communicates nothing runs", /read.?only|nothing runs/i.test(MODE_LABELS.PLAN.label + MODE_LABELS.PLAN.description));

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
