import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWithinWorkspace } from "../../workspacePath.js";

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-workspacepath-test-"));
  await fs.mkdir(path.join(root, "sub"), { recursive: true });
  await fs.writeFile(path.join(root, "sub", "file.txt"), "inside\n", "utf-8");

  console.log("resolveWithinWorkspace: ordinary paths inside the workspace:");
  {
    const result = await resolveWithinWorkspace(root, ".");
    const realRoot = await fs.realpath(root);
    check("the workspace root itself resolves ok", result.ok && result.abs === realRoot);
  }
  {
    const result = await resolveWithinWorkspace(root, "sub/file.txt");
    check("an ordinary relative path inside the workspace resolves ok", result.ok);
  }

  console.log("\nresolveWithinWorkspace: naive path traversal (security audit — the original bug this fixes):");
  {
    const result = await resolveWithinWorkspace(root, "../../../../etc/passwd");
    check("'../../../../etc/passwd' is rejected", !result.ok);
  }

  console.log("\nresolveWithinWorkspace: sibling-directory prefix bypass (security audit M2):");
  {
    // A naive `abs.startsWith(resolvedRoot)` string check (no trailing
    // separator) would let a sibling directory whose name happens to start
    // with the workspace root's own name through — e.g. root "/tmp/x" vs
    // "/tmp/x-evil/secret.txt", which starts with "/tmp/x" as a raw string.
    const siblingRoot = `${root}-evil`;
    await fs.mkdir(siblingRoot, { recursive: true });
    await fs.writeFile(path.join(siblingRoot, "secret.txt"), "not yours\n", "utf-8");
    const relativeToSibling = path.relative(root, path.join(siblingRoot, "secret.txt"));
    const result = await resolveWithinWorkspace(root, relativeToSibling);
    check("a sibling directory whose name starts with the workspace root's name is still rejected", !result.ok);
    await fs.rm(siblingRoot, { recursive: true, force: true });
  }

  console.log("\nresolveWithinWorkspace: symlink escape (security audit H2):");
  {
    // A symlink INSIDE the workspace pointing OUTSIDE it — a cloned repo
    // can ship exactly this. The naive path looks like it's inside the
    // workspace; only resolving the real (symlink-following) path reveals
    // it isn't.
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-workspacepath-outside-"));
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "not yours either\n", "utf-8");
    const linkPath = path.join(root, "escape-link");
    await fs.symlink(outsideDir, linkPath, "dir");

    const result = await resolveWithinWorkspace(root, "escape-link/secret.txt");
    check("a symlink pointing outside the workspace is rejected even though the naive path looks fine", !result.ok);

    await fs.rm(linkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  console.log("\nresolveWithinWorkspace: a symlink that stays INSIDE the workspace is still allowed:");
  {
    const linkPath = path.join(root, "inside-link");
    await fs.symlink(path.join(root, "sub"), linkPath, "dir");
    const result = await resolveWithinWorkspace(root, "inside-link/file.txt");
    check("a symlink pointing to another spot inside the same workspace is allowed", result.ok);
    await fs.rm(linkPath, { force: true });
  }

  console.log("\nresolveWithinWorkspace: a brand-new path whose parent doesn't exist yet (edit_file creating a new nested file):");
  {
    const result = await resolveWithinWorkspace(root, "brand/new/nested/file.txt");
    check("a not-yet-existing nested path still resolves (no symlink to check yet) rather than erroring", result.ok);
  }

  console.log("\nresolveWithinWorkspace: a DANGLING symlink escape is rejected (final review Critical #1 — confirmed live exploit: edit_file wrote through a symlink whose target didn't exist yet, since fs.realpath throws on it and the old fallback silently treated that exactly like 'not yet created'):");
  {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-workspacepath-dangling-outside-"));
    const linkPath = path.join(root, "dangling.txt");
    // The symlink itself exists; its TARGET does not — this is the case
    // fs.realpath can't resolve but fs.lstat can still see.
    await fs.symlink(path.join(outsideDir, "newfile.txt"), linkPath);

    const result = await resolveWithinWorkspace(root, "dangling.txt");
    check("a dangling symlink (target doesn't exist) is rejected outright, not silently treated as 'not yet created'", !result.ok);

    await fs.rm(linkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  console.log("\nresolveWithinWorkspace: a dangling symlink nested under an existing directory is still rejected:");
  {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-workspacepath-dangling2-outside-"));
    const linkPath = path.join(root, "sub", "also-dangling.txt");
    await fs.symlink(path.join(outsideDir, "newfile.txt"), linkPath);

    const result = await resolveWithinWorkspace(root, "sub/also-dangling.txt");
    check("a dangling symlink nested inside an existing real directory is still rejected", !result.ok);

    await fs.rm(linkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  await fs.rm(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
