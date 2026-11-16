import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { toolResultBudgetChars, toolResultText, LARGE_RESULT_CHARS } from "../../toolResultText.js";
import { readFileTool } from "../../tools/readFile.js";
import { AgentSession } from "../../agent.js";
import { defaultToolRegistry } from "../../toolRegistry.js";
import { MockProvider } from "../../providers/mockProvider.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("toolResultBudgetChars:");
check("an unknown context size gets the large limit", toolResultBudgetChars(undefined) === LARGE_RESULT_CHARS);
check("the embedded models' 8,192 tokens give about 6,000 characters", toolResultBudgetChars(8192) === 6144);
check("a large known context is capped at the large limit", toolResultBudgetChars(200_000) === LARGE_RESULT_CHARS);
check("a very small context still gets a usable amount", toolResultBudgetChars(1000) === 3000);
check("the large limit holds a full read_file result", LARGE_RESULT_CHARS > 20_000 + 400);

console.log("\ntoolResultText:");
{
  const small = { ok: true, output: { a: 1 } };
  check("a result within the limit is plain JSON", toolResultText(small, 6000) === JSON.stringify(small));
  const big = { ok: true, output: { stdout: "x".repeat(50_000) } };
  const text = toolResultText(big, 6000);
  check("a result over the limit is cut to the limit", text.length <= 6000 && text.length > 5900);
  check("the cut text says that it was cut, and how long the result was", text.includes("This result was cut") && text.includes(String(JSON.stringify(big).length)));
  check("the notice comes last, where the old cut dropped everything", text.trimEnd().endsWith("]"));
}

console.log("\nread_file cuts at a line and says where it stopped:");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-result-size-"));
try {
  const lines = Array.from({ length: 400 }, (_, i) => `const value${i} = "line ${i} with a \\"quoted\\" word";`);
  await fs.writeFile(path.join(root, "big.js"), lines.join("\n") + "\n");
  await fs.writeFile(path.join(root, "small.js"), "one\ntwo\n");
  const read = async (input: any, maxResultChars?: number) => (await readFileTool.execute(input, { workspaceRoot: root, log: () => {}, maxResultChars })) as any;

  const small = await read({ path: "small.js" }, 6144);
  check("a small file is returned whole, with no note", small.output.content === "one\ntwo\n" && small.truncated === false && small.output.note === undefined);

  const part = await read({ path: "big.js" }, 6144);
  const shown = String(part.output.content).split("\n");
  check("a large file is marked as cut", part.truncated === true && part.output.totalLines === 400);
  check("the content stops at the end of a line", shown.every((line, i) => line === lines[i]));
  check("the result says which lines it holds", part.output.startLine === 1 && part.output.endLine === shown.length && shown.length < 400);
  check("the note tells the model how to read the next part", String(part.output.note).includes(`offset ${shown.length + 1}`) && String(part.output.note).includes("of 400"));
  check("the whole result fits the limit, so nothing more is cut from it", toolResultText(part, 6144) === JSON.stringify(part));

  const next = await read({ path: "big.js", offset: part.output.endLine + 1, limit: 2000 }, 6144);
  check("the next read continues from that line", next.output.startLine === part.output.endLine + 1 && String(next.output.content).split("\n")[0] === lines[part.output.endLine]);
  check("a ranged read that is too long is also cut at a line, with a note", next.output.endLine < 400 && String(next.output.note).includes(`offset ${next.output.endLine + 1}`) && toolResultText(next, 6144) === JSON.stringify(next));

  const whole = await read({ path: "big.js" }, LARGE_RESULT_CHARS);
  check("a model with a large context gets far more of the file", String(whole.output.content).split("\n").length > shown.length * 2);

  const tail = await read({ path: "big.js", offset: 399, limit: 10 }, 6144);
  check("a short range near the end has no note", tail.output.endLine === 400 && tail.truncated === false && tail.output.note === undefined);

  await fs.writeFile(path.join(root, "oneline.js"), "y".repeat(30_000));
  const oneLine = await read({ path: "oneline.js" }, 6144);
  check("a single line longer than the limit still returns its start", oneLine.truncated === true && oneLine.output.content.length > 1000 && toolResultText(oneLine, 6144) === JSON.stringify(oneLine));

  console.log("\nAgentSession sizes results to the model:");
  const run = async (contextWindowTokens: number | undefined) => {
    const provider = new MockProvider([
      { turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "big.js" } }] } },
      { turn: { type: "final", content: "done" } },
    ]);
    if (contextWindowTokens) provider.contextWindowTokens = contextWindowTokens;
    const session = new AgentSession({ workspaceRoot: root, model: "mock", provider, tools: defaultToolRegistry(), permissionMode: "PLAN" });
    for await (const event of session.run("look at the big file")) void event;
    return session.getMessages().find((m) => m.role === "tool" && m.name === "read_file")?.content ?? "";
  };
  const forSmall = await run(8192);
  const forLarge = await run(undefined);
  check("a small-context model is shown a result that fits its limit", forSmall.length <= 6144);
  check("that result is complete JSON with the note in it", JSON.parse(forSmall).output.note.includes("offset"));
  check("a model with an unknown context is shown more than the old 6,000 characters", forLarge.length > 12_000);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
