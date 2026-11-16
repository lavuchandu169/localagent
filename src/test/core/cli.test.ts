// cli.ts had no test coverage at all before this (test-engineer finding,
// full-project audit). parseArgs is now exported and main()'s
// auto-invocation is guarded behind an entry-point check specifically so
// this import doesn't also run the whole CLI.
import { parseArgs, reportRun, describeUnhandledFailure } from "../../cli.js";
import { AgentSession } from "../../agent.js";
import { defaultToolRegistry } from "../../toolRegistry.js";
import { MockProvider, type MockScriptEntry } from "../../providers/mockProvider.js";
import os from "node:os";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("parseArgs:");
{
  const { args, positional } = parseArgs(["fix", "the", "bug"]);
  check("plain words with no -- flags all become positional", positional.join(" ") === "fix the bug" && Object.keys(args).length === 0);
}
{
  const { args, positional } = parseArgs(["--workspace", "/tmp/repo", "do", "the", "thing"]);
  check("a --flag followed by a non-flag value consumes it as that flag's value", args.workspace === "/tmp/repo");
  check("positional words after the flag+value are still collected, in order", positional.join(" ") === "do the thing");
}
{
  const { args } = parseArgs(["--mode", "PLAN"]);
  check("a flag's value is captured under the flag's name with the leading -- stripped", args.mode === "PLAN");
}
{
  const { args, positional } = parseArgs(["--provider", "anthropic", "task", "text"]);
  check("a flag can appear before positional args and both are still parsed correctly", args.provider === "anthropic" && positional.join(" ") === "task text");
}
{
  // A boolean-style flag with no value — either it's the last argv entry,
  // or the next entry is itself another flag, not a value for this one.
  const { args, positional } = parseArgs(["--verbose"]);
  check("a flag with nothing after it at all gets the literal string \"true\", not swallowing nothing", args.verbose === "true");
}
{
  const { args, positional } = parseArgs(["--verbose", "--mode", "PLAN"]);
  check("a flag immediately followed by another flag does NOT consume that next flag as its value", args.verbose === "true");
  check("the following flag is still parsed as its own, separate flag", args.mode === "PLAN");
  check("neither flag leaks into positional", positional.length === 0);
}
{
  const { args } = parseArgs(["--base-url", "http://localhost:11434"]);
  check("a multi-word flag name (base-url) works the same as a single-word one", args["base-url"] === "http://localhost:11434");
}
{
  const { args, positional } = parseArgs([]);
  check("an empty argv produces empty args and empty positional, not a crash", Object.keys(args).length === 0 && positional.length === 0);
}

console.log("\nparseArgs with a switch that takes no value:");
{
  const { args, positional } = parseArgs(["--json", "fix", "the", "bug"]);
  check("--json does not swallow the first word of the task", args.json === "true" && positional.join(" ") === "fix the bug");
}
{
  const { args, positional } = parseArgs(["fix", "it", "--json", "--mode", "PLAN"]);
  check("--json works anywhere among the arguments", args.json === "true" && args.mode === "PLAN" && positional.join(" ") === "fix it");
}

async function headless(script: MockScriptEntry[], json: boolean, mode: "DEFAULT" | "PLAN" = "DEFAULT") {
  const out: string[] = [];
  const err: string[] = [];
  const session = new AgentSession({
    workspaceRoot: os.tmpdir(),
    model: "mock",
    provider: new MockProvider(script),
    tools: defaultToolRegistry(),
    permissionMode: mode,
    onApprovalNeeded: async () => ({ approved: false }),
  });
  const success = await reportRun(session.run("do it"), { json, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { out, err, success };
}

console.log("\nreportRun in JSON mode:");
{
  const r = await headless([{ turn: { type: "final", content: "All good." } }], true);
  const parsed = r.out.map((l) => JSON.parse(l));
  check("every line on stdout is one JSON object", parsed.length > 0 && parsed.every((o) => typeof o === "object" && typeof o.type === "string"));
  const last = parsed[parsed.length - 1];
  check("the last line is the result, with the final answer", last.type === "result" && last.success === true && last.text === "All good.");
  check("a successful run returns true", r.success === true);
  check("nothing is written to stderr on a clean run", r.err.length === 0);
}
{
  const r = await headless(
    [{ turn: { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "echo hi" } }] } }, { turn: { type: "final", content: "I could not run it." } }],
    true
  );
  const parsed = r.out.map((l) => JSON.parse(l));
  check("a command that needs approval is reported and refused, since nobody can answer", parsed.some((o) => o.type === "permission.request" && o.decision === "ASK") && parsed.some((o) => o.type === "tool.result" && o.result.ok === false) === false);
  check("the run still ends with a result line", parsed[parsed.length - 1].type === "result");
}
{
  const r = await headless([{ throws: new Error("provider down") }], true);
  const parsed = r.out.map((l) => JSON.parse(l));
  const last = parsed[parsed.length - 1];
  check("a failed run reports success false and returns false", last.type === "result" && last.success === false && r.success === false);
  check("the error is in the stream", parsed.some((o) => o.type === "error" && /provider down/.test(o.message)));
}
{
  const r = await headless([{ turn: { type: "final", content: "line one\nline \"two\"" } }], true);
  check("text with line breaks and quotes stays on one valid JSON line", r.out.every((l) => !l.includes("\n")) && JSON.parse(r.out[r.out.length - 1]!).text === "line one\nline \"two\"");
}

console.log("\nreportRun in text mode:");
{
  const r = await headless([{ turn: { type: "final", content: "All good." } }], false);
  check("prints the answer and a done line", r.out.some((l) => l.includes("All good.")) && r.out.some((l) => l.includes("[done] success=true")) && r.success === true);
}
{
  const r = await headless([{ throws: new Error("provider down") }], false);
  check("an error goes to stderr and the run returns false", r.err.some((l) => /provider down/.test(l)) && r.success === false);
}

console.log("\ndescribeUnhandledFailure:");
{
  const download = describeUnhandledFailure({ message: "Url: https://example.com/a.gguf, Status code: 403", statusCode: 403, url: "https://example.com/a.gguf" });
  check("a failed download says so, with the status and what to do", download.includes("download stopped (HTTP 403)") && download.includes("Run the same command again"));
  check("it does not print the long signed URL", !download.includes("example.com"));
  check("any other error gives its first line", describeUnhandledFailure(new Error("boom\n  at stack")) === "localagent stopped with an error: boom");
  check("a value that is not an error is still described", describeUnhandledFailure("plain text").includes("plain text"));
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
