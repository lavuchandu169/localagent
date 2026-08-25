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

const SECRET_LIKE = [
  /([A-Za-z0-9_\-]*(SECRET|TOKEN|PASSWORD|API_KEY|APIKEY)[A-Za-z0-9_\-]*\s*=\s*)(\S+)/gi,
  /(sk-[A-Za-z0-9]{20,})/g,
  /(ghp_[A-Za-z0-9]{20,})/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_LIKE) {
    out = out.replace(re, (_m, ...groups) => {
      if (groups.length >= 3 && typeof groups[0] === "string") {
        return `${groups[0]}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return out;
}
