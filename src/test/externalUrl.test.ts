import { isAllowedExternalUrl } from "../electron/externalUrl.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("isAllowedExternalUrl (security audit finding: open-external-no-url-scheme-allowlist):");
check("allows a plain https URL", isAllowedExternalUrl("https://example.com") === true);
check("allows a plain http URL", isAllowedExternalUrl("http://example.com") === true);
check("allows https with a path and query string", isAllowedExternalUrl("https://example.com/path?query=1") === true);
check("rejects a file: URL", isAllowedExternalUrl("file:///etc/passwd") === false);
check("rejects a javascript: URL", isAllowedExternalUrl("javascript:alert(1)") === false);
check("rejects a custom app-deep-link scheme", isAllowedExternalUrl("myapp://do-something") === false);
check("rejects a vscode: URL (a documented Electron shell.openExternal hardening gap)", isAllowedExternalUrl("vscode://file/etc/passwd") === false);
check("rejects a data: URL", isAllowedExternalUrl("data:text/html,<script>alert(1)</script>") === false);
check("rejects an unparseable string", isAllowedExternalUrl("not a url at all") === false);
check("rejects an empty string", isAllowedExternalUrl("") === false);

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
