// Security audit finding M5: APFS (macOS) and NTFS (Windows) are
// case-insensitive by default, so a path like ".GIT/hooks/pre-commit" or
// ".ENV" bypassed every one of these regexes even though it resolves to
// the exact same file isProtectedPath exists to block. All patterns are
// case-insensitive (`i` flag) for this reason.
const PROTECTED_PATTERNS = [
  /\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /credentials\..*/i,
  /secrets\..*/i,
  /\.ssh\//i,
  /\.aws\//i,
  /(^|\/)\.git\//i,
];

export function isProtectedPath(relPath: string): boolean {
  return PROTECTED_PATTERNS.some((r) => r.test(relPath));
}

// keepPrefix: true means the pattern's first capture group is a prefix to
// preserve (e.g. "TOKEN=") while the rest of the match is discarded.
// keepPrefix: false means the whole match IS the secret, so nothing is
// preserved. Getting this wrong per-pattern is what silently defeated
// redaction below prior to this fix — see the callback's own comment.
const SECRET_LIKE: { pattern: RegExp; keepPrefix: boolean }[] = [
  { pattern: /([A-Za-z0-9_\-]*(SECRET|TOKEN|PASSWORD|API_KEY|APIKEY)[A-Za-z0-9_\-]*\s*=\s*)(\S+)/gi, keepPrefix: true },
  // Security audit finding: sk-prefix-hyphen-gap. Both Anthropic's real key
  // shape (sk-ant-api03-...) and OpenAI's modern project-scoped keys
  // (sk-proj-...) place a hyphen a few characters after "sk-" — the old
  // alphanumeric-only class never accumulated the required 20+ run for
  // either. Hyphen/underscore now allowed, matching the sibling AIza
  // pattern below.
  { pattern: /(sk-[A-Za-z0-9_-]{20,})/g, keepPrefix: false },
  // ghp_ = classic personal access token. gho_/ghu_/ghs_/ghr_ = OAuth App,
  // GitHub App user, GitHub App server, and GitHub App refresh tokens
  // respectively (github.com/settings/developers). This feature's Device
  // Flow connection produces a gho_ token — the other three cost nothing
  // extra to cover in the same pattern.
  { pattern: /(gh[oprsu]_[A-Za-z0-9]{20,})/g, keepPrefix: false },
  // Gemini's request URL embeds the raw API key directly as a query
  // string (?key=AIza...) rather than in a header like every other
  // provider — if that full URL were ever accidentally logged (e.g. in
  // a network error message), the generic KEY=VALUE pattern above
  // wouldn't catch it, since "key=" there isn't preceded by the literal
  // text SECRET/TOKEN/PASSWORD/API_KEY/APIKEY. AIza-prefixed keys are
  // Google's own documented format.
  { pattern: /(AIza[A-Za-z0-9_\-]{30,})/g, keepPrefix: false },
  // Final review Important #6: a human-approved SAFE_READ command whose
  // argument escapes the workspace (e.g. `cat ~/.ssh/id_rsa`, asked
  // rather than auto-run since hasEscapingArguments now catches it) can
  // still have its real content dumped verbatim into run_command's
  // output. [\s\S]*? (not `.`) so the match spans the key body's
  // embedded newlines too.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, keepPrefix: false },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern, keepPrefix } of SECRET_LIKE) {
    out = out.replace(pattern, (_match, ...args) => {
      // String.replace's callback receives (match, ...capturedGroups,
      // offset, fullString) — for a single-capture-group regex, args here
      // is [capturedGroup, offset, fullString], which is NOT "3 captured
      // groups"; treating args[0] as a prefix-to-keep in that case would
      // preserve the secret itself and only decorate it with a suffix.
      // keepPrefix (set per-pattern above, not inferred from args.length)
      // is what actually distinguishes the two shapes.
      if (keepPrefix) {
        const prefix = args[0];
        return `${prefix}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return out;
}
