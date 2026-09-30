const PROTECTED_PATTERNS = [
  /\.env(\..*)?$/,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /credentials\..*/,
  /secrets\..*/,
  /\.ssh\//,
  /\.aws\//,
  /(^|\/)\.git\//,
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
  { pattern: /(sk-[A-Za-z0-9]{20,})/g, keepPrefix: false },
  // ghp_ = classic personal access token. gho_/ghu_/ghs_/ghr_ = OAuth App,
  // GitHub App user, GitHub App server, and GitHub App refresh tokens
  // respectively (github.com/settings/developers). This feature's Device
  // Flow connection produces a gho_ token — the other three cost nothing
  // extra to cover in the same pattern.
  { pattern: /(gh[oprsu]_[A-Za-z0-9]{20,})/g, keepPrefix: false },
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
