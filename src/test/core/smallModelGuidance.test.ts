import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { importCandidates, isTestFile } from "../../testImports.js";
import { AgentSession, emptyReplyNudge } from "../../agent.js";
import { defaultToolRegistry } from "../../toolRegistry.js";
import { MockProvider } from "../../providers/mockProvider.js";
import type { AgentEvent, ChatResponse } from "../../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const final = (content: string): ChatResponse => ({ turn: { type: "final", content } });
const fence = "```";

console.log("isTestFile:");
check("names with .test. or .spec. are test files", isTestFile("test/math.test.js") && isTestFile("src/a/login.spec.ts"));
check("files in a test folder are test files", isTestFile("tests/helpers.js") && isTestFile("src/__tests__/a.ts") && isTestFile("test/setup.js"));
check("python and go test names are test files", isTestFile("pkg/test_math.py") && isTestFile("pkg/math_test.go"));
check("ordinary source files are not", !isTestFile("src/math.js") && !isTestFile("src/latest.js") && !isTestFile("src/contest/a.js"));

console.log("\nimportCandidates:");
{
  const cjs = importCandidates("test/math.test.js", 'const assert = require("node:assert");\nconst { sum } = require("../src/math.js");\n');
  check("a relative require is resolved from the test file's folder", cjs.length === 1 && cjs[0]![0] === "src/math.js");
  check("a package import is ignored", !cjs.flat().some((p) => p.includes("assert")));

  const esm = importCandidates("src/auth/login.test.ts", 'import { login } from "./login.js";\nimport helper from "../util";\nimport "./setup";\n');
  check("an import with a .js extension also tries the TypeScript file", esm[0]!.includes("src/auth/login.js") && esm[0]!.includes("src/auth/login.ts"));
  check("an import with no extension tries each extension and an index file", esm[1]!.includes("src/util.ts") && esm[1]!.includes("src/util/index.ts"));
  check("imports come in the order of the file", esm.length === 3 && esm[2]![0] === "src/auth/setup");

  check("an import that leaves the workspace is ignored", importCandidates("a.test.js", 'require("../outside.js")').length === 0);
  check("an import of another test file is ignored", importCandidates("test/a.test.js", 'require("./b.test.js")').length === 0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-small-model-"));
try {
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, "test"));
  await fs.writeFile(path.join(root, "src", "math.js"), "function sum(a, b) {\n  return a - b;\n}\nmodule.exports = { sum };\n");
  await fs.writeFile(path.join(root, "src", "extra.js"), "module.exports = {};\n");
  await fs.writeFile(path.join(root, "src", "more.js"), "module.exports = {};\n");
  await fs.writeFile(path.join(root, "src", "third.js"), "module.exports = {};\n");
  await fs.writeFile(path.join(root, "test", "math.test.js"), 'const { sum } = require("../src/math.js");\nrequire("../src/extra");\nrequire("../src/more.js");\nrequire("../src/third.js");\nrequire("../src/missing.js");\n');
  await fs.writeFile(path.join(root, "package.json"), '{ "scripts": { "test": "exit 1" } }');

  const session = (script: ChatResponse[], extra: Record<string, unknown> = {}) => {
    const provider = new MockProvider(script);
    Object.assign(provider, extra);
    return { provider, session: new AgentSession({ workspaceRoot: root, model: "mock", provider, tools: defaultToolRegistry(), permissionMode: "AUTO_SAFE", onApprovalNeeded: async () => ({ approved: true }) }) };
  };
  const collect = async (s: AgentSession, task: string) => {
    const events: AgentEvent[] = [];
    for await (const event of s.run(task)) events.push(event);
    return events;
  };
  const reads = (events: AgentEvent[]) => events.filter((e) => e.type === "tool.start" && e.call.name === "read_file").map((e: any) => e.call.arguments.path as string);

  console.log("\nA task that names a test file (two real models edited the test, not the bug):");
  {
    const { session: s } = session([final("ok")]);
    const read = reads(await collect(s, "The test fails when I run `node test/math.test.js`. Tell me why."));
    check("the test file is read first", read[0] === "test/math.test.js");
    check("then the source file it imports", read[1] === "src/math.js");
    check("at most two imported files are read, in import order", JSON.stringify(read) === JSON.stringify(["test/math.test.js", "src/math.js", "src/extra.js"]));
    check("the model has the source file's content before its first turn", s.getMessages().some((m) => m.role === "tool" && m.content.includes("return a - b")));
  }
  {
    const { session: s } = session([final("ok")]);
    const read = reads(await collect(s, "Explain src/math.js to me."));
    check("a task that names a source file reads only that file", JSON.stringify(read) === JSON.stringify(["src/math.js"]));
  }

  console.log("\nThe nudge after code with no edit_file call:");
  {
    const nudges = async (extra: Record<string, unknown>) => {
      const { session: s } = session([final(`Here is the fix:\n${fence}js\nfunction sum(a, b) { return a + b; }\n${fence}`), final("I only explained.")], extra);
      await collect(s, "fix the bug in src/math.js");
      return s.getMessages().filter((m) => m.role === "user" && m.content.includes("never called edit_file"));
    };
    const local = await nudges({ recoversTextToolCalls: true });
    check("a provider that reads calls from text is shown the JSON form to copy", local.length === 1 && local[0]!.content.includes('{"name": "edit_file", "arguments": {"path":'));
    const cloud = await nudges({});
    check("a provider with real tool calls only is not shown it", cloud.length === 1 && !cloud[0]!.content.includes('"name": "edit_file"'));
  }
  {
    const { session: s } = session([final(`I will run the test next.\n${fence}bash\nnode test/math.test.js\n${fence}`)]);
    const events = await collect(s, "fix the bug in src/math.js");
    check("a block with only a shell command does not cause a nudge", !events.some((e) => e.type === "status" && e.message.includes("nudging")));
  }

  console.log("\nThe retry after an empty reply:");
  {
    check("it repeats the request", emptyReplyNudge("fix the sum bug").includes("fix the sum bug") && emptyReplyNudge("x").includes("reply was empty"));
    check("a very long request is shortened", emptyReplyNudge("y".repeat(5000)).length < 1800);
    const { session: s } = session([final(""), final("answer")]);
    await collect(s, "what is two plus two?");
    const history = s.getMessages();
    const at = history.findIndex((m) => m.role === "user" && m.content.includes("reply was empty"));
    check("the retry is sent with the repeated request, and the answer follows it", at !== -1 && history[at]!.content.includes("what is two plus two?") && history[at + 1]?.content === "answer");
  }
  {
    const { session: s } = session([{ turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "npm test" } }] } }, final(""), final("")]);
    const done = (await collect(s, "run the tests")).find((e) => e.type === "done") as any;
    check("silence after a failed command ends the task as a failure", done?.success === false && String(done.summary).includes("last command it ran failed"));
  }
  {
    const { session: s } = session([{ turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "node -e 0" } }] } }, final(""), final("")]);
    const done = (await collect(s, "run a quick check")).find((e) => e.type === "done") as any;
    check("silence after a command that passed still ends as a success", done?.success === true);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
