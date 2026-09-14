import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { detectVerifyCommand } from "../verifyCommand.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "localagent-verifycmd-test-"));
}

console.log("detectVerifyCommand:");
async function run() {
  {
    const dir = await tmp();
    check("an empty workspace with no recognizable project detects nothing", (await detectVerifyCommand(dir)) === null);
  }

  {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" } }), "utf-8");
    check("package.json with a real test script detects npm test", (await detectVerifyCommand(dir)) === "npm test");
  }

  {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "utf-8"
    );
    check("package.json with npm's own default placeholder script detects nothing", (await detectVerifyCommand(dir)) === null);
  }

  {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x" }), "utf-8");
    check("package.json with no test script at all detects nothing", (await detectVerifyCommand(dir)) === null);
  }

  {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "pytest.ini"), "[pytest]\n", "utf-8");
    check("a pytest.ini detects pytest", (await detectVerifyCommand(dir)) === "pytest");
  }

  {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts = '-q'\n", "utf-8");
    check("a pyproject.toml with a [tool.pytest...] section detects pytest", (await detectVerifyCommand(dir)) === "pytest");
  }

  {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "test_math.py"), "def test_add():\n    assert 1 + 1 == 2\n", "utf-8");
    check("a test_*.py file with no other config detects pytest", (await detectVerifyCommand(dir)) === "pytest");
  }

  {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n", "utf-8");
    check("a Cargo.toml detects cargo test", (await detectVerifyCommand(dir)) === "cargo test");
  }

  {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "go.mod"), "module x\n", "utf-8");
    check("a go.mod detects go test ./...", (await detectVerifyCommand(dir)) === "go test ./...");
  }

  {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" } }), "utf-8");
    await fs.writeFile(path.join(dir, "go.mod"), "module x\n", "utf-8");
    check("package.json's real test script wins over a go.mod also present", (await detectVerifyCommand(dir)) === "npm test");
  }
}
await run();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
