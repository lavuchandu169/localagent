// cli.ts had no test coverage at all before this (test-engineer finding,
// full-project audit). parseArgs is now exported and main()'s
// auto-invocation is guarded behind an entry-point check specifically so
// this import doesn't also run the whole CLI.
import { parseArgs } from "../../cli.js";

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

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
