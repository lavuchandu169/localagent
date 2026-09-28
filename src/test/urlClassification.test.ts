import { isExternal } from "../electron/urlClassification.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("isExternal:");

check("the local dashboard itself is not external", !isExternal("http://127.0.0.1:8687/keys"));
check("a real external https URL is external", isExternal("https://console.anthropic.com/settings/keys"));
check("a real external http URL is external", isExternal("http://example.com"));
check("a non-http(s) scheme is never treated as external (denied, not opened)", !isExternal("javascript:alert(1)"));
check("a file: URL is never treated as external", !isExternal("file:///etc/passwd"));
check("an unparseable URL is never treated as external, not a crash", !isExternal("not a url at all"));
check("a different loopback-looking hostname than 127.0.0.1 IS external (not a loose substring match)", isExternal("http://127.0.0.1.evil.com/"));

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
