// src/test/protected.test.ts
import { redactSecrets, isProtectedPath } from "../protected.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("redactSecrets:");
{
  const ghoToken = "gho_" + "a".repeat(36);
  const result = redactSecrets(`remote: https://x-access-token:${ghoToken}@github.com/owner/repo.git`);
  check("redacts a gho_-prefixed GitHub OAuth token", !result.includes(ghoToken));
  check("keeps the surrounding text", result.includes("remote: https://x-access-token:") && result.includes("@github.com/owner/repo.git"));
}
{
  // Embedded directly in a URL, with no "TOKEN="/"SECRET="-style marker
  // nearby — the pre-existing generic KEY=VALUE pattern in SECRET_LIKE
  // would silently redact a "token=..." form regardless of prefix, which
  // would make this check pass even without the prefix-specific fix. This
  // context isolates what's actually being tested (same reasoning as the
  // gho_ case above).
  const ghuToken = "ghu_" + "b".repeat(36);
  check("redacts a ghu_-prefixed token", !redactSecrets(`remote: https://x-access-token:${ghuToken}@github.com/owner/repo.git`).includes(ghuToken));
}
{
  const ghsToken = "ghs_" + "c".repeat(36);
  check("redacts a ghs_-prefixed token", !redactSecrets(`remote: https://x-access-token:${ghsToken}@github.com/owner/repo.git`).includes(ghsToken));
}
{
  const ghrToken = "ghr_" + "d".repeat(36);
  check("redacts a ghr_-prefixed token", !redactSecrets(`remote: https://x-access-token:${ghrToken}@github.com/owner/repo.git`).includes(ghrToken));
}
{
  const ghpToken = "ghp_" + "e".repeat(36);
  check("still redacts classic ghp_ tokens (no regression)", !redactSecrets(`remote: https://x-access-token:${ghpToken}@github.com/owner/repo.git`).includes(ghpToken));
}
{
  // Pre-existing bug found while writing this task's tests: the shared
  // replace callback treated a single-capture-group match's (offset,
  // fullString) positional args as if they were real capture groups,
  // which made it preserve the secret itself and merely append a decoy
  // "[REDACTED]" suffix — sk-/ghp_ tokens were never actually redacted in
  // production. Fixed alongside the gh*_ prefix additions since it's the
  // same code path; this pins the fix so it can't silently regress.
  const skKey = "sk-" + "f".repeat(36);
  check("sk- keys are now actually redacted, not just suffixed", !redactSecrets(`key: ${skKey}`).includes(skKey));
}
{
  check("the KEY=VALUE prefix is still preserved (no regression in the one case that needs it)", redactSecrets("API_KEY=supersecretvalue123").startsWith("API_KEY="));
}
{
  check("isProtectedPath is untouched by this change", isProtectedPath(".env") === true && isProtectedPath("src/index.ts") === false);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
