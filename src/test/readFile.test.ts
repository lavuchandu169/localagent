import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileTool } from "../tools/readFile.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-readfile-test-"));
  await fs.writeFile(path.join(root, "a.txt"), "hello\n", "utf-8");
  const ctx = { workspaceRoot: root, log: () => {} };

  console.log("readFileTool: ordinary read still works:");
  {
    const result = await readFileTool.execute({ path: "a.txt" }, ctx);
    check("reads the file", result.ok && result.output?.content === "hello\n");
  }

  console.log("\nreadFileTool: symlink escape is blocked (security audit H2):");
  {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-readfile-outside-"));
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "not yours\n", "utf-8");
    const linkPath = path.join(root, "escape-link");
    await fs.symlink(outsideDir, linkPath, "dir");

    const result = await readFileTool.execute({ path: "escape-link/secret.txt" }, ctx);
    check("a symlink pointing outside the workspace is refused, not read", result.ok === false);

    await fs.rm(linkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  console.log("\nreadFileTool: sibling-directory prefix bypass is blocked (security audit M2):");
  {
    const siblingRoot = `${root}-evil`;
    await fs.mkdir(siblingRoot, { recursive: true });
    await fs.writeFile(path.join(siblingRoot, "secret.txt"), "not yours\n", "utf-8");
    const relativeToSibling = path.relative(root, path.join(siblingRoot, "secret.txt"));
    const result = await readFileTool.execute({ path: relativeToSibling }, ctx);
    check("a sibling directory whose name starts with the workspace root's name is still refused", result.ok === false);
    await fs.rm(siblingRoot, { recursive: true, force: true });
  }

  console.log("\nreadFileTool: a symlink whose NAME looks innocent but resolves inside .git is still protected (final review Important #4, confirmed live):");
  {
    // isProtectedPath previously only ever checked the REQUESTED relative
    // path string ("cfg") — a symlink literally named "cfg" pointing at
    // .git/config sailed straight past it, since "cfg" itself matches no
    // protected pattern. Only the RESOLVED, workspace-relative target
    // ("​.git/config") is what isProtectedPath needs to see.
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "config"), "[core]\n", "utf-8");
    await fs.symlink(path.join(root, ".git", "config"), path.join(root, "cfg"));

    const result = await readFileTool.execute({ path: "cfg" }, ctx);
    check("a symlink named 'cfg' resolving inside .git is refused, not read", result.ok === false);

    await fs.rm(path.join(root, "cfg"), { force: true });
    await fs.rm(path.join(root, ".git"), { recursive: true, force: true });
  }

  console.log("\nreadFileTool: offset/limit lets a large file be read past the default character cutoff:");
  {
    // 5000 numbered lines — far more than the default 20000-character cap
    // would ever show from the start alone (each "line N\n" is ~7-9 bytes,
    // so the whole file is comfortably past the cap).
    const lineCount = 5000;
    const bigContent = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await fs.writeFile(path.join(root, "big.txt"), bigContent, "utf-8");

    const plain = await readFileTool.execute({ path: "big.txt" }, ctx);
    check("a plain read (no offset/limit) reports the file's real total line count", plain.ok && plain.output?.totalLines === lineCount);
    check("a plain read is still truncated by the character cap, same as before", plain.truncated === true);

    const ranged = await readFileTool.execute({ path: "big.txt", offset: 4001, limit: 10 }, ctx);
    check("offset/limit reads the requested range successfully", ranged.ok === true);
    check("the range starts at the requested line", ranged.output?.content.startsWith("line 4001") ?? false);
    check("the range ends at the requested line, not beyond it", ranged.output?.content.split("\n").pop() === "line 4010");
    check("the range covers exactly 10 lines", ranged.output?.content.split("\n").length === 10);
    check("startLine/endLine reflect the actual range returned", ranged.output?.startLine === 4001 && ranged.output?.endLine === 4010);
    check("totalLines is still reported alongside the range", ranged.output?.totalLines === lineCount);
    check("truncated is true — there's more past line 4010", ranged.truncated === true);
  }

  console.log("\nreadFileTool: offset/limit near the end of the file doesn't overrun or report truncated:");
  {
    const result = await readFileTool.execute({ path: "big.txt", offset: 4995, limit: 100 }, ctx);
    check("a limit extending past the file's end is clamped, not an error", result.ok === true);
    check("endLine is clamped to the real last line", result.output?.endLine === 5000);
    check("nothing is reported as truncated once the range reaches the real end", result.truncated === false);
  }

  console.log("\nreadFileTool: offset/limit still applies the workspace-escape and protected-path checks (same resolution path as a plain read):");
  {
    const result = await readFileTool.execute({ path: "../../etc/hosts", offset: 1, limit: 10 }, ctx);
    check("a path escaping the workspace is still refused with offset/limit set", result.ok === false);
  }

  await fs.rm(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
