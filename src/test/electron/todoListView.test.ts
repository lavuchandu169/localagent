import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://example.com/" });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

const { renderTodoList } = await import("../../electron/renderer/todoListView.js");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("renderTodoList:");
{
  const list = renderTodoList([
    { content: "Read the parser", status: "done" },
    { content: "Fix the bug", status: "in_progress" },
    { content: "<img src=x onerror=alert(1)>", status: "pending" },
  ]);
  check("draws one row per step, in order", list !== null && list.children.length === 3 && list.children[0]!.querySelector(".todo-text")!.textContent === "Read the parser");
  check("each row carries its status as a class", !!list && list.children[0]!.classList.contains("todo-done") && list.children[1]!.classList.contains("todo-in_progress") && list.children[2]!.classList.contains("todo-pending"));
  check("the status is also readable as text, not by mark alone", !!list && (list.children[1]!.textContent ?? "").includes("in progress"));
  check("step text is never parsed as HTML", !!list && list.querySelector("img") === null && list.children[2]!.querySelector(".todo-text")!.textContent === "<img src=x onerror=alert(1)>");
}
check("a list that is not an array falls back to the plain card", renderTodoList("nope") === null && renderTodoList(undefined) === null && renderTodoList([]) === null);
check("a step with an unknown status or no text falls back to the plain card", renderTodoList([{ content: "x", status: "weird" }]) === null && renderTodoList([{ content: "  ", status: "done" }]) === null && renderTodoList([null]) === null);
check("a class name cannot be injected through the status", renderTodoList([{ content: "x", status: "done evil" }]) === null);

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
