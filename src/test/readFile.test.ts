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

  console.log("\nreadFileTool: a secret straddling the whole-file character-truncation boundary is still fully redacted, not partially leaked (security audit finding: truncate-before-redact-order):");
  {
    // MAX_CONTENT_CHARS is 20000 — the BEGIN line and secret body land
    // comfortably BEFORE that boundary, with padding pushing the closing
    // END marker comfortably PAST it. Under the old (buggy) order,
    // slicing to 20000 chars BEFORE redacting excludes the closing END
    // marker entirely, so the PEM regex (which requires it) never
    // matches and the body — fully present in the truncated slice —
    // survives completely raw in the output.
    const filler = "A".repeat(19000);
    const secretBody = "SECRETPEMBODYDATA1234567890";
    const padding = "B".repeat(2000); // pushes the closing END marker past the 20000-char cutoff
    const pemBlock = `-----BEGIN RSA PRIVATE KEY-----\n${secretBody}\n${padding}\n-----END RSA PRIVATE KEY-----\n`;
    await fs.writeFile(path.join(root, "straddle.txt"), filler + pemBlock, "utf-8");

    const result = await readFileTool.execute({ path: "straddle.txt" }, ctx);
    check("the result is ok", result.ok === true);
    check("the PEM body never appears raw in the truncated output", !(result.output?.content ?? "").includes(secretBody));
    check("the redaction marker is present instead", (result.output?.content ?? "").includes("[REDACTED]"));
  }

  console.log("\nreadFileTool: a secret straddling an offset/limit line-range boundary is still fully redacted, not partially leaked (security audit finding: truncate-before-redact-order, ranged branch):");
  {
    // The requested range (lines 11-12) covers the PEM's BEGIN line and
    // body, but deliberately stops one line short of its closing END
    // marker (line 13) — exactly the shape that let a multi-line secret
    // survive raw under the old per-branch slice-then-redact order, since
    // redactSecrets never saw a complete BEGIN...END span to match.
    // Redacting against the full file content first (this fix) means the
    // match is found regardless of where the requested line range cuts
    // off; the precise line numbering of what comes after a collapsed
    // multi-line match is a known, accepted display-only side effect —
    // this only asserts the actual security property, not exact
    // post-redaction line indices.
    const before = Array.from({ length: 10 }, (_, i) => `before-${i + 1}`);
    const secretBody = "RANGEDSECRETBODYDATA";
    const pemLines = ["-----BEGIN RSA PRIVATE KEY-----", secretBody, "-----END RSA PRIVATE KEY-----"];
    const after = Array.from({ length: 10 }, (_, i) => `after-${i + 1}`);
    const content = [...before, ...pemLines, ...after].join("\n") + "\n";
    await fs.writeFile(path.join(root, "ranged-straddle.txt"), content, "utf-8");

    const result = await readFileTool.execute({ path: "ranged-straddle.txt", offset: 11, limit: 2 }, ctx);
    check("the result is ok", result.ok === true);
    check(
      "the secret body never appears raw, even though the requested range cuts off before the closing END marker",
      !(result.output?.content ?? "").includes(secretBody)
    );
  }

  await fs.rm(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
