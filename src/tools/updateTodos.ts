import type { Tool } from "../types.js";

export const MAX_TODOS = 30;
const MAX_TODO_LENGTH = 200;
const STATUSES = ["pending", "in_progress", "done"] as const;

export type TodoStatus = (typeof STATUSES)[number];
export interface Todo {
  content: string;
  status: TodoStatus;
}

interface Input {
  todos: Todo[];
}

/**
 * A task list the model keeps for itself on a multi-step task. The tool
 * stores nothing: the list lives in the conversation, where the model
 * sees its own latest version, and the app draws it as a checklist.
 * Each call replaces the whole list.
 */
export const updateTodosTool: Tool<Input, { todos: Todo[]; summary: string }> = {
  name: "update_todos",
  description:
    "Keep a task list for work with 3 or more steps. Call it first with every step as pending, then call it again with the full list each time a step starts (in_progress) or finishes (done). Do not use it for a simple task or a question.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The full list, in order. Each call replaces the previous list.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "One short step" },
            status: { type: "string", enum: [...STATUSES] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async execute(input) {
    const raw = (input as { todos?: unknown } | null)?.todos;
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, output: null, error: "todos must be a list with at least one step." };
    if (raw.length > MAX_TODOS) return { ok: false, output: null, error: `Too many steps (max ${MAX_TODOS}). Group them into fewer, larger steps.` };
    const todos: Todo[] = [];
    for (const [i, item] of raw.entries()) {
      const content = typeof (item as Todo | null)?.content === "string" ? (item as Todo).content.trim() : "";
      const status = (item as Todo | null)?.status;
      if (!content) return { ok: false, output: null, error: `Step ${i + 1} needs a non-empty content.` };
      if (content.length > MAX_TODO_LENGTH) return { ok: false, output: null, error: `Step ${i + 1} is too long (max ${MAX_TODO_LENGTH} characters).` };
      if (!STATUSES.includes(status as TodoStatus)) return { ok: false, output: null, error: `Step ${i + 1} has an unknown status. Use pending, in_progress or done.` };
      todos.push({ content, status: status as TodoStatus });
    }
    const done = todos.filter((t) => t.status === "done").length;
    return { ok: true, output: { todos, summary: `${done} of ${todos.length} done` } };
  },
};
