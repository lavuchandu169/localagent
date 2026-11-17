import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { outlineFile } from "../../fileOutline.js";
import { readFileTool } from "../../tools/readFile.js";
import { toolResultText } from "../../toolResultText.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("outlineFile:");
{
  const js = [
    "// header",
    "function plain(a) {}",
    "export async function exported() {}",
    "const arrow = (a, b) => a + b;",
    "export const typed = async (x: number): Promise<void> => {};",
    "const expr = function () {};",
    "class Widget {}",
    "export default class Main extends Widget {}",
    "const notAFunction = 5;",
    "  if (x) { call(y); }",
    "return function inner() {};",
  ].join("\n");
  const o = outlineFile(js);
  check("JavaScript and TypeScript functions are counted", o.functions === 5);
  check("classes are counted", o.classes === 2 && o.definitions === 7);
  check("names come with their line numbers, in file order", o.names[0] === "plain (line 2)" && o.names[2] === "arrow (line 4)" && o.names[5] === "Widget (line 7)");
  check("a plain value and a call are not definitions", !o.names.some((n) => n.startsWith("notAFunction") || n.startsWith("call")));

  const py = outlineFile("import os\n\ndef first():\n    pass\n\nclass Thing:\n    async def method(self):\n        pass\n");
  check("Python functions, methods and classes are counted", py.functions === 2 && py.classes === 1 && py.names.includes("method (line 7)"));

  const go = outlineFile("package main\n\nfunc Run() {}\nfunc (s *Server) Start() error { return nil }\ntype Server struct {}\n");
  check("Go functions, methods and types are counted", go.functions === 2 && go.classes === 1 && go.names.includes("Start (line 4)"));

  const rust = outlineFile("pub fn build() {}\nasync fn load() {}\npub struct Config {}\n");
  check("Rust functions and structs are counted", rust.functions === 2 && rust.classes === 1);

  const many = outlineFile(Array.from({ length: 500 }, (_, i) => `function step${i}() {}`).join("\n"), 300);
  check("the count is complete when the list of names is cut", many.functions === 500 && many.namesCut === true && many.names.length < 30);
  check("the list of names stays inside its limit", many.names.join(", ").length <= 300);
  check("a short file's list is not cut", outlineFile("function a() {}").namesCut === false);
  check("a very long line is skipped", outlineFile(`function a() {}\nfunction ${"x".repeat(500)}() {}`).functions === 1);
  check("an empty file has no definitions", outlineFile("").definitions === 0);
  const later = outlineFile("function a() {}\nfunction b() {}\nfunction c() {}", 900, 2);
  check("the names can start at a later line while the counts cover the whole file", later.functions === 3 && JSON.stringify(later.names) === JSON.stringify(["b (line 2)", "c (line 3)"]));
}

console.log("\nread_file sends the outline with a part of a file:");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-outline-"));
try {
  const body = Array.from({ length: 70 }, (_, i) => `function ordersStep${i}(input) {\n  // step ${i} of the pipeline\n  if (!input) throw new Error("bad");\n  return { ...input, stage: ${i} };\n}`).join("\n");
  await fs.writeFile(path.join(root, "orders.js"), body + "\n");
  await fs.writeFile(path.join(root, "small.js"), "function only() {}\n");
  const read = async (input: any, maxResultChars?: number) => (await readFileTool.execute(input, { workspaceRoot: root, log: () => {}, maxResultChars })) as any;

  const part = await read({ path: "orders.js" }, 6144);
  const shown = (String(part.output.content).match(/^function /gm) ?? []).length;
  check("the part shown holds only some of the functions", part.truncated === true && shown > 5 && shown < 70);
  check("the whole-file count is the true total", part.output.wholeFile.functions === 70 && part.output.wholeFile.lines === part.output.totalLines);
  check("the note says that the app counted the whole file", String(part.output.wholeFile.note).includes("in the whole file") && String(part.output.wholeFile.note).includes("70 function definitions"));
  const listed: string[] = part.output.wholeFile.definitionsNotShown;
  check("the definitions after the part shown are listed with their lines", listed.length > 5 && listed.every((d) => Number(/line (\d+)/.exec(d)![1]) > part.output.endLine));
  check("the first one listed is the first function that is not shown", listed[0] === `ordersStep${shown} (line ${shown * 5 + 1})`);
  check("the whole-file facts come before the content", JSON.stringify(part).indexOf('"wholeFile"') < JSON.stringify(part).indexOf('"content"'));
  check("the result still fits the limit, with the outline in it", toolResultText(part, 6144) === JSON.stringify(part));

  const whole = await read({ path: "small.js" }, 6144);
  check("a file that fits has no outline", whole.output.wholeFile === undefined && whole.truncated === false);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
