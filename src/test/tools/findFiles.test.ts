import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findFilesTool, compileGlob, MAX_FIND_RESULTS } from "../../tools/findFiles.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("compileGlob:");
{
  const m = (glob: string, p: string) => compileGlob(glob).test(p);
  check("* matches inside one path segment", m("src/*.ts", "src/a.ts") && !m("src/*.ts", "src/deep/a.ts"));
  check("** matches any number of folders, including none", m("src/**/*.ts", "src/a.ts") && m("src/**/*.ts", "src/x/y/a.ts") && !m("src/**/*.ts", "lib/a.ts"));
  check("a pattern with no slash matches the file name at any depth", m("*.md", "README.md") && m("*.md", "docs/guide/intro.md") && !m("*.md", "docs/intro.mdx"));
  check("? matches one character", m("a?.ts", "ab.ts") && !m("a?.ts", "abc.ts") && !m("a?.ts", "a/.ts"));
  check("{a,b} matches either option", m("src/*.{ts,tsx}", "src/a.tsx") && m("src/*.{ts,tsx}", "src/a.ts") && !m("src/*.{ts,tsx}", "src/a.js"));
  check("regex characters in a pattern are literal", m("a+b(1).txt", "a+b(1).txt") && !m("a+b(1).txt", "aab1.txt") && !m("file.ts", "fileXts"));
  check("a trailing ** matches everything below a folder", m("src/**", "src/a/b.ts") && !m("src/**", "lib/a.ts"));
  check("matching is exact from start to end", !m("a.ts", "xa.ts") && !m("src/a.ts", "src/a.tsx"));
}

console.log("\ncompileGlob stays fast on hostile patterns:");
{
  const longPath = Array.from({ length: 40 }, (_, i) => `dir${i}`).join("/") + "/file.txt";
  const timed = (glob: string) => {
    const started = Date.now();
    let threw = false;
    try {
      compileGlob(glob).test(longPath);
    } catch {
      threw = true;
    }
    return { ms: Date.now() - started, threw };
  };
  const manyGlobstars = timed("**/".repeat(40) + "nomatch");
  check("repeated **/ segments do not blow up matching time", manyGlobstars.ms < 500);
  check("repeated **/ behaves like a single one", compileGlob("**/**/**/*.ts").test("a/b/c.ts") && compileGlob("**/**/*.ts").test("c.ts"));
  check("repeated * behaves like a single one", compileGlob("a***b.ts").test("aXYb.ts") && compileGlob("a*b.ts").test("aXYb.ts"));
  const started = Date.now();
  const slowForRegex = compileGlob("x/" + "*a".repeat(60) + "b").test("x/" + "a".repeat(250));
  check("many wildcards against a long name are answered at once, and correctly", slowForRegex === false && Date.now() - started < 500);
  check("many wildcards still match when they should", compileGlob("x/" + "*a".repeat(20) + "*").test("x/" + "a".repeat(30)));
  const manyBraces = timed("{a,b}".repeat(40));
  check("a pattern with too many brace combinations is refused", manyBraces.threw && manyBraces.ms < 500);
  check("nested ** and * combine correctly", compileGlob("src/**/test/*.spec.ts").test("src/a/b/test/x.spec.ts") && !compileGlob("src/**/test/*.spec.ts").test("src/a/b/x.spec.ts"));
  check("a pattern does not match a longer path that only starts with it", !compileGlob("src/a").test("src/a/b.ts") && !compileGlob("src/*").test("src/a/b.ts"));
  const deep = Array.from({ length: 60 }, () => "a").join("/");
  const startedDeep = Date.now();
  const deepResult = compileGlob("**/a/".repeat(25) + "nomatch").test(deep);
  check("many ** segments against a deep path are rejected at once", deepResult === false && Date.now() - startedDeep < 500);
  check("a star can match an empty string", compileGlob("a*.ts").test("a.ts") && compileGlob("*").test("x"));
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-findfiles-test-"));
const outside = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-findfiles-outside-"));
try {
  const write = async (rel: string) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), "");
  };
  for (const f of ["README.md", "src/index.ts", "src/app.tsx", "src/a/b/c/d/e/deep.ts", "docs/guide.md", "node_modules/pkg/index.ts", ".git/config", "dist/out.ts", ".env"]) await write(f);
  await fs.writeFile(path.join(outside, "secret.ts"), "");
  await fs.symlink(outside, path.join(root, "linked"));
  const ctx = { workspaceRoot: root, log: () => {} };

  console.log("\nfindFilesTool:");
  {
    const r = await findFilesTool.execute({ pattern: "**/*.ts" }, ctx);
    check("finds matching files at any depth, deeper than list_directory goes", r.ok && r.output!.files.includes("src/index.ts") && r.output!.files.includes("src/a/b/c/d/e/deep.ts"));
    check("skips dependency, build and git folders", r.ok && !r.output!.files.some((f) => f.startsWith("node_modules/") || f.startsWith("dist/") || f.startsWith(".git/")));
    check("does not follow a symlink out of the workspace", r.ok && !r.output!.files.some((f) => f.includes("secret.ts")));
    check("returns sorted, workspace-relative paths with forward slashes", r.ok && JSON.stringify(r.output!.files) === JSON.stringify([...r.output!.files].sort()) && !r.output!.files.some((f) => path.isAbsolute(f)));
  }
  {
    const r = await findFilesTool.execute({ pattern: "*.md" }, ctx);
    check("a bare pattern finds files by name in every folder", r.ok && JSON.stringify(r.output!.files) === JSON.stringify(["README.md", "docs/guide.md"]));
  }
  {
    const r = await findFilesTool.execute({ pattern: "*.ts", path: "src/a" }, ctx);
    check("path limits the search, and results stay relative to the workspace", r.ok && JSON.stringify(r.output!.files) === JSON.stringify(["src/a/b/c/d/e/deep.ts"]));
  }
  {
    const r = await findFilesTool.execute({ pattern: "*.nothing" }, ctx);
    check("no match is an empty list, not an error", r.ok && r.output!.files.length === 0 && r.truncated !== true);
  }
  {
    const r = await findFilesTool.execute({ pattern: "*.ts", path: path.relative(root, outside) }, ctx);
    check("a path outside the workspace is refused", r.ok === false);
  }
  {
    const r = await findFilesTool.execute({ pattern: "*.ts", path: "linked" }, ctx);
    check("a symlinked folder that leaves the workspace is refused as a starting point", r.ok === false);
  }
  {
    const r1 = await findFilesTool.execute({ pattern: "" } as any, ctx);
    const r2 = await findFilesTool.execute({} as any, ctx);
    const r3 = await findFilesTool.execute({ pattern: "x".repeat(600) }, ctx);
    check("a missing, empty or oversized pattern is a clear error, not a crash", r1.ok === false && r2.ok === false && r3.ok === false);
    const r4 = await findFilesTool.execute({ pattern: "{a,b}".repeat(40) }, ctx);
    check("a pattern with too many brace combinations is a clear error from the tool", r4.ok === false && /combinations/i.test(r4.error ?? ""));
  }
  {
    const r = await findFilesTool.execute({ pattern: "/etc/*" }, ctx);
    const r2 = await findFilesTool.execute({ pattern: "../*" }, ctx);
    check("a pattern cannot reach outside the workspace", r.ok && r.output!.files.length === 0 && r2.ok && r2.output!.files.length === 0);
  }
  {
    for (let i = 0; i < MAX_FIND_RESULTS + 20; i++) await write(`many/f${String(i).padStart(4, "0")}.log`);
    const r = await findFilesTool.execute({ pattern: "many/*.log" }, ctx);
    check("results are capped and flagged as truncated", r.ok && r.output!.files.length === MAX_FIND_RESULTS && r.truncated === true);
  }
  check("it is a read-only tool", findFilesTool.permission === "READ" && findFilesTool.name === "find_files");
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
