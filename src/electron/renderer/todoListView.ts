// Draws an update_todos call's arguments as a checklist, in place of the
// raw JSON every other tool card shows. Pure DOM building from untrusted
// model output: text goes in through textContent only.

const MARKS: Record<string, string> = { pending: "○", in_progress: "◐", done: "●" };
const LABELS: Record<string, string> = { pending: "to do", in_progress: "in progress", done: "done" };

/** Returns null when the arguments are not a usable list, so the caller falls back to the plain card. */
export function renderTodoList(todos: unknown): HTMLElement | null {
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const list = document.createElement("ul");
  list.className = "todo-list";
  for (const item of todos.slice(0, 30)) {
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    const status = typeof item?.status === "string" && item.status in MARKS ? (item.status as string) : null;
    if (!content || !status) return null;
    const row = document.createElement("li");
    row.className = `todo-item todo-${status}`;
    const mark = document.createElement("span");
    mark.className = "todo-mark";
    mark.textContent = MARKS[status]!;
    mark.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "todo-text";
    text.textContent = content.slice(0, 200);
    const label = document.createElement("span");
    label.className = "visually-hidden";
    label.textContent = ` (${LABELS[status]})`;
    row.append(mark, text, label);
    list.appendChild(row);
  }
  return list;
}
