import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { expandCommand, loadCustomCommands, parseSlashCommand, resolveSlashCommand } from "../../slashCommands.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

async function silencingWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

console.log("parseSlashCommand:");
{
  const p = parseSlashCommand("/review src/a.ts and src/b.ts");
  check("splits the name from the arguments", p?.name === "review" && p.args === "src/a.ts and src/b.ts");
  check("a command with no arguments has empty args", parseSlashCommand("/compact")?.args === "" && parseSlashCommand("  /compact  ")?.name === "compact");
  check("arguments keep their inner line breaks", parseSlashCommand("/note line one\nline two")?.args === "line one\nline two");
  check("ordinary text is not a command", parseSlashCommand("please review /src/a.ts") === null && parseSlashCommand("hello") === null);
  check("a path at the start of a task is not a command", parseSlashCommand("/Users/me/project/a.ts has a bug") === null && parseSlashCommand("/usr/bin/env is missing") === null);
  check("a bare slash or a name with other characters is not a command", parseSlashCommand("/") === null && parseSlashCommand("/Review") === null && parseSlashCommand("/re_view x") === null && parseSlashCommand("//comment") === null);
}

console.log("\nexpandCommand:");
check("$ARGUMENTS is replaced everywhere it appears", expandCommand("Review $ARGUMENTS. Then test $ARGUMENTS.", "a.ts") === "Review a.ts. Then test a.ts.");
check("arguments are appended when the template has no placeholder", expandCommand("Write release notes.", "for v2") === "Write release notes.\n\nfor v2");
check("no arguments and no placeholder leaves the template alone", expandCommand("Write release notes.", "") === "Write release notes.");
check("an unused placeholder becomes empty", expandCommand("Review $ARGUMENTS now", "") === "Review  now");
check("special replacement patterns in the arguments stay literal", expandCommand("Say $ARGUMENTS", "$& and $1 and $$") === "Say $& and $1 and $$");

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-slash-commands-"));
const outside = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-slash-commands-outside-"));
try {
  await fs.writeFile(path.join(dir, "review.md"), "# Review a file carefully\n\nReview $ARGUMENTS for bugs.\n");
  await fs.writeFile(path.join(dir, "notes.md"), String.fromCharCode(0xfeff) + "Write release notes.");
  await fs.writeFile(path.join(dir, "Bad Name.md"), "x");
  await fs.writeFile(path.join(dir, "readme.txt"), "not a command");
  await fs.writeFile(path.join(dir, "empty.md"), "   \n");
  await fs.writeFile(path.join(dir, "huge.md"), "x".repeat(30_000));
  await fs.writeFile(path.join(dir, "help.md"), "try to replace the built-in help");
  await fs.writeFile(path.join(dir, "compact.md"), "try to replace the built-in compact");
  await fs.writeFile(path.join(outside, "secret.md"), "outside");
  await fs.symlink(path.join(outside, "secret.md"), path.join(dir, "linked.md"));
  await fs.mkdir(path.join(dir, "folder.md"));

  console.log("\nloadCustomCommands:");
  const commands = await silencingWarnings(() => loadCustomCommands(dir));
  check("loads valid .md files, sorted by name", JSON.stringify(commands.map((c) => c.name)) === JSON.stringify(["notes", "review"]));
  check("the body is the file text without a BOM or outer whitespace", commands.find((c) => c.name === "notes")?.template === "Write release notes.");
  check("the description is the first line, without a heading mark", commands.find((c) => c.name === "review")?.description === "Review a file carefully");
  check("a missing folder means no commands", (await loadCustomCommands(path.join(dir, "nope"))).length === 0);
  check("an undefined folder means no commands", (await loadCustomCommands(undefined)).length === 0);

  console.log("\nresolveSlashCommand:");
  {
    const r = await silencingWarnings(() => resolveSlashCommand("/review src/a.ts", dir));
    check("a custom command becomes its expanded task", r.kind === "task" && r.task === "# Review a file carefully\n\nReview src/a.ts for bugs." && r.command === "review");
  }
  {
    const r = await resolveSlashCommand("fix the bug in /src/a.ts", dir);
    check("ordinary text passes through unchanged", r.kind === "task" && r.task === "fix the bug in /src/a.ts" && r.command === undefined);
  }
  check("/compact is built in", (await resolveSlashCommand("/compact", dir)).kind === "compact");
  {
    const r = await silencingWarnings(() => resolveSlashCommand("/help", dir));
    check("/help lists the built-in and the custom commands", r.kind === "message" && r.text.includes("/compact") && r.text.includes("/review") && r.text.includes("Review a file carefully") && r.text.includes("/notes"));
    check("/help says where custom commands live", r.kind === "message" && r.text.includes(dir));
  }
  {
    const r = await silencingWarnings(() => resolveSlashCommand("/reveiw src/a.ts", dir));
    check("an unknown command is answered with a message, not sent to the model", r.kind === "message" && r.text.includes("/reveiw") && r.text.includes("/help"));
  }
  {
    const r = await silencingWarnings(() => resolveSlashCommand("/help", dir));
    check("a file cannot replace a built-in command", r.kind === "message" && !r.text.includes("try to replace"));
  }
  {
    const r = await resolveSlashCommand("/help", undefined);
    check("with no commands folder, the built-ins still work", r.kind === "message" && r.text.includes("/compact"));
  }
} finally {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
