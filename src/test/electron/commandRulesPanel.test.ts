import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "../../electron/renderer/index.html"), "utf-8");
const dom = new JSDOM(html, { url: "https://example.com/" });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const rules = new Map<string, string[]>([["/work/a", ["npm test", "<img src=x onerror=alert(1)>"]]]);
const removed: string[] = [];
let listShouldFail = false;
(dom.window as any).agent = {
  listCommandRules: async (workspaceRoot: string) => {
    if (listShouldFail) throw new Error("ipc failed");
    return [...(rules.get(workspaceRoot) ?? [])];
  },
  removeCommandRule: async (workspaceRoot: string, command: string) => {
    removed.push(`${workspaceRoot}::${command}`);
    rules.set(workspaceRoot, (rules.get(workspaceRoot) ?? []).filter((c) => c !== command));
  },
};

const { initCommandRulesPanel, refreshCommandRulesPanel } = await import("../../electron/renderer/commandRulesPanel.js");
const list = dom.window.document.getElementById("command-rules-list")!;
const hint = dom.window.document.getElementById("command-rules-hint")!;
let workspace: string | null = null;
initCommandRulesPanel({ getWorkspaceRoot: () => workspace });

console.log("Always-allowed commands panel:");
await refreshCommandRulesPanel();
check("with no workspace it explains that one is needed and lists nothing", list.children.length === 0 && /workspace/i.test(hint.textContent ?? ""));

workspace = "/work/a";
await refreshCommandRulesPanel();
check("it lists each rule for the active workspace", list.children.length === 2 && list.children[0]?.querySelector("code")?.textContent === "npm test");
check("a command is shown as text, never parsed as HTML", list.querySelector("img") === null && list.children[1]?.querySelector("code")?.textContent === "<img src=x onerror=alert(1)>");
check("the hint names the workspace", (hint.textContent ?? "").includes("/work/a"));

(list.children[0]!.querySelector("button") as any).click();
await new Promise((r) => setTimeout(r, 0));
await new Promise((r) => setTimeout(r, 0));
check("Remove asks the main process to remove that exact rule", JSON.stringify(removed) === JSON.stringify(["/work/a::npm test"]));
check("the list redraws without the removed rule", list.children.length === 1 && list.children[0]?.querySelector("code")?.textContent !== "npm test");

await refreshCommandRulesPanel();
await refreshCommandRulesPanel();
check("refreshing twice does not duplicate rows", list.children.length === 1);

workspace = "/work/empty";
await refreshCommandRulesPanel();
check("a workspace with no rules says how to add one", list.children.length === 0 && /Always allow/.test(hint.textContent ?? ""));

listShouldFail = true;
workspace = "/work/a";
await refreshCommandRulesPanel();
check("a failed read shows an error and no stale rows", list.children.length === 0 && /could not/i.test(hint.textContent ?? ""));

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
