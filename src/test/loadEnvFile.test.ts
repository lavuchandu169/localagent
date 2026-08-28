import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { parseEnvFile, loadEnvFile } from "../electron/loadEnvFile.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("parseEnvFile:");

{
  const parsed = parseEnvFile("FOO=bar\nBAZ=qux");
  check("parses plain KEY=value lines", parsed.FOO === "bar" && parsed.BAZ === "qux");
}
{
  const parsed = parseEnvFile("export FOO=bar\nexport BAZ=qux");
  check("strips a leading export keyword", parsed.FOO === "bar" && parsed.BAZ === "qux");
}
{
  const parsed = parseEnvFile('FOO="bar baz"\nBAZ=\'single quoted\'');
  check("strips matching surrounding double quotes", parsed.FOO === "bar baz");
  check("strips matching surrounding single quotes", parsed.BAZ === "single quoted");
}
{
  const parsed = parseEnvFile("# a comment\n\nFOO=bar\n   \nBAZ=qux");
  check("skips comment and blank lines", Object.keys(parsed).length === 2 && parsed.FOO === "bar" && parsed.BAZ === "qux");
}
{
  const parsed = parseEnvFile("NOEQUALS\nFOO=bar");
  check("skips a line with no '=' instead of throwing", parsed.FOO === "bar" && !("NOEQUALS" in parsed));
}
{
  const parsed = parseEnvFile("FOO=bar=baz");
  check("value itself may contain '=' (only the first '=' splits key/value)", parsed.FOO === "bar=baz");
}

console.log("\nloadEnvFile:");

async function runTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-envfile-test-"));

  {
    const key = "LOCALAGENT_TEST_LOAD_ENV_FILE_UNSET";
    delete process.env[key];
    await fs.writeFile(path.join(dir, ".env"), `${key}=from-file\n`, "utf-8");
    loadEnvFile(dir);
    check("sets a variable that wasn't already in process.env", process.env[key] === "from-file");
    delete process.env[key];
  }

  {
    const key = "LOCALAGENT_TEST_LOAD_ENV_FILE_PRESET";
    process.env[key] = "from-shell";
    await fs.writeFile(path.join(dir, ".env"), `${key}=from-file\n`, "utf-8");
    loadEnvFile(dir);
    check("never overwrites a variable already set in process.env", process.env[key] === "from-shell");
    delete process.env[key];
  }

  {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-envfile-test-noenv-"));
    let threw = false;
    try {
      loadEnvFile(emptyDir);
    } catch {
      threw = true;
    }
    check("is a silent no-op when there's no .env file", !threw);
  }

  console.log(failures === 0 ? "\nAll loadEnvFile tests passed." : `\n${failures} loadEnvFile test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

runTests();
