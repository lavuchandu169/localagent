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
  // Security audit finding (confirmed, medium): sk-prefix-hyphen-gap. The
  // bare sk- pattern's character class was [A-Za-z0-9]{20,} — no hyphen
  // or underscore — so it never matched Anthropic's real key shape
  // (sk-ant-api03-...) or OpenAI's modern project-scoped keys
  // (sk-proj-...), both of which place a hyphen a few characters after
  // "sk-": the required 20+ alphanumeric run never accumulates. The
  // sibling AIza (Gemini) pattern already allows hyphen/underscore in
  // its own class, confirming this was an inconsistency, not a
  // deliberate choice.
  const anthropicKey = "sk-ant-api03-" + "a".repeat(30);
  check("a bare Anthropic-shaped key (sk-ant-api03-...) is redacted", !redactSecrets(`x-api-key: ${anthropicKey}`).includes(anthropicKey));
  const openaiProjectKey = "sk-proj-" + "b".repeat(30);
  check("a bare OpenAI project-scoped key (sk-proj-...) is redacted", !redactSecrets(`Authorization: Bearer ${openaiProjectKey}`).includes(openaiProjectKey));
}
{
  check("the KEY=VALUE prefix is still preserved (no regression in the one case that needs it)", redactSecrets("API_KEY=supersecretvalue123").startsWith("API_KEY="));
}
{
  check("isProtectedPath is untouched by this change", isProtectedPath(".env") === true && isProtectedPath("src/index.ts") === false);
}

console.log("\nisProtectedPath is case-insensitive (security audit M5 — APFS/NTFS are case-insensitive by default, so '.GIT/hooks/pre-commit' bypassed the case-sensitive regexes):");
{
  check("'.GIT/hooks/pre-commit' (uppercase) is still protected", isProtectedPath(".GIT/hooks/pre-commit") === true);
  check("'.Git/config' (mixed case) is still protected", isProtectedPath(".Git/config") === true);
  check("'.ENV' (uppercase) is still protected", isProtectedPath(".ENV") === true);
  check("'Secrets.YAML' (uppercase) is still protected", isProtectedPath("Secrets.YAML") === true);
  check("an ordinary non-secret path is still NOT protected", isProtectedPath("src/Index.ts") === false);
}

console.log(
  "\nisProtectedPath tolerates a trailing dot/space on .pem/.key (security audit finding: trailing-dot-space-anchor-gap — Windows' Win32 file APIs strip trailing dots/spaces from a path component at actual file-creation/open/delete time, so a model-supplied 'secret.pem ' or 'secret.pem.' could pass this check yet have the OS normalize the on-disk operation to the literal protected filename):"
);
{
  check("'secret.pem ' (trailing space) is still protected", isProtectedPath("secret.pem ") === true);
  check("'secret.pem.' (trailing dot) is still protected", isProtectedPath("secret.pem.") === true);
  check("'secret.pem..  ' (multiple trailing dots/spaces) is still protected", isProtectedPath("secret.pem..  ") === true);
  // "private.key", not "id_rsa.key" — the latter would also match the
  // separate, unanchored id_rsa pattern regardless of this fix, which
  // would mask whether the .key$ anchor itself was actually widened.
  check("'private.key ' (trailing space) is still protected", isProtectedPath("private.key ") === true);
  check("'private.key.' (trailing dot) is still protected", isProtectedPath("private.key.") === true);
  check("a genuinely different file ('secret.pem.txt', not just trailing dots/spaces) is still NOT protected", isProtectedPath("secret.pem.txt") === false);
}

console.log("\nredactSecrets covers a bare Gemini API key, not just OpenAI/GitHub prefixes (security audit — Gemini's key rides in the request URL query string, not a header, so any future accidental URL logging needs this):");
{
  const geminiKey = "AIzaSy" + "g".repeat(33);
  const result = redactSecrets(`fetch failed: https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${geminiKey}`);
  check("redacts a bare AIza-prefixed Gemini key", !result.includes(geminiKey));
}

console.log("\nredactSecrets covers a PEM private-key body (final review Important #6 — now that a SAFE_READ cat/git-diff escaping an absolute path downgrades to ASK rather than silently auto-running, a human-approved one could still dump a raw key into run_command's output):");
{
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdefg\nmoreBase64HereAndHere==\n-----END RSA PRIVATE KEY-----";
  const result = redactSecrets(`cat output:\n${pem}\ndone`);
  check("the PEM body is redacted", !result.includes("MIIEpAIBAAKCAQEA1234567890abcdefg"));
  check("surrounding text survives", result.includes("cat output:") && result.includes("done"));
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
