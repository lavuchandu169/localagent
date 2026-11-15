import { updateTodosTool, MAX_TODOS } from "../../tools/updateTodos.js";
import { defaultToolRegistry } from "../../toolRegistry.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

const ctx = { workspaceRoot: "/nowhere", log: () => {} };

console.log("updateTodosTool:");
{
  const r = await updateTodosTool.execute(
    {
      todos: [
        { content: "Read the parser", status: "done" },
        { content: "  Fix the bug  ", status: "in_progress" },
        { content: "Run the tests", status: "pending" },
      ],
    },
    ctx
  );
  check("a valid list is accepted", r.ok === true);
  check("the list comes back cleaned, in order", r.ok && JSON.stringify(r.output!.todos.map((t) => t.content)) === JSON.stringify(["Read the parser", "Fix the bug", "Run the tests"]));
  check("the summary counts finished items", r.ok && r.output!.summary === "1 of 3 done");
}
{
  const r = await updateTodosTool.execute({ todos: [{ content: "Only step", status: "done" }] }, ctx);
  check("a finished list says so", r.ok && r.output!.summary === "1 of 1 done");
}
{
  const bad: unknown[] = [
    {},
    { todos: "not a list" },
    { todos: [] },
    { todos: [{ content: "", status: "pending" }] },
    { todos: [{ content: "x", status: "started" }] },
    { todos: [{ content: 5, status: "pending" }] },
    { todos: [null] },
    { todos: Array.from({ length: MAX_TODOS + 1 }, (_, i) => ({ content: `step ${i}`, status: "pending" })) },
    { todos: [{ content: "x".repeat(500), status: "pending" }] },
  ];
  let allRefused = true;
  for (const input of bad) {
    const r = await updateTodosTool.execute(input as any, ctx);
    if (r.ok !== false || typeof r.error !== "string" || r.error.length === 0) allRefused = false;
  }
  check("a malformed list is a clear error, never a crash", allRefused);
}
check("it is read-only: it changes nothing on disk and needs no approval", updateTodosTool.permission === "READ" && updateTodosTool.name === "update_todos");

console.log("\nTool registry:");
check("the task list tool is not offered by default", defaultToolRegistry().get("update_todos") === undefined && defaultToolRegistry().availableTools().length === 8);
{
  const registry = defaultToolRegistry(() => [], { taskList: true });
  check("it is offered when asked for", registry.get("update_todos") !== undefined && registry.availableTools().length === 9);
  check("asking for the task list does not add the helper tool", registry.get("delegate_task") === undefined);
  check("it appears in the schema sent to the model", registry.toSchema().some((t) => t.name === "update_todos"));
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
