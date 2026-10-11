import { formatPerfBadge } from "../../electron/renderer/perfBadge.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("formatPerfBadge:");
{
  check("formats a typical reading", formatPerfBadge(42, 500, 8192) === "⚡ ~42 tok/s · 500/8192 ctx");
}
{
  check("rounds a fractional rate to the nearest whole token/sec, not truncating it toward zero", formatPerfBadge(41.6, 0, 8192) === "⚡ ~42 tok/s · 0/8192 ctx");
}
{
  check("a genuinely very slow rate still shows as its real (low) value, not hidden or floored to something misleadingly higher", formatPerfBadge(0.3, 10, 8192) === "⚡ ~0 tok/s · 10/8192 ctx");
}
{
  check("context usage numbers are shown exactly as given, not abbreviated into something lossy", formatPerfBadge(100, 8192, 8192) === "⚡ ~100 tok/s · 8192/8192 ctx");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
