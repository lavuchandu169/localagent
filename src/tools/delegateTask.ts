import type { Tool } from "../types.js";

const MAX_TASK_LENGTH = 4000;
const MAX_FINDINGS_CHARS = 5000;

interface Input {
  task: string;
}

/**
 * Hands a self-contained question to a helper that starts with a fresh
 * context, so a long search does not fill the main conversation. The
 * helper is created by the agent session (ToolContext.runSubagent): it
 * can read and search the workspace and nothing else.
 */
export const delegateTaskTool: Tool<Input, { findings: string; toolCalls: number; truncated: boolean }> = {
  name: "delegate_task",
  description:
    "Give a research question to a helper that starts with a fresh context and can only read and search files. Use it for a broad search whose details you do not need to keep, for example \"find every place that calls parse() and say what each one passes\". The helper sees nothing of this conversation, so write the task in full. It returns its findings as text. Do not use it for a question you can answer with one or two tool calls.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: { task: { type: "string", description: "The complete question for the helper, with every file name or detail it needs." } },
    required: ["task"],
  },
  async execute(input, ctx) {
    const task = typeof input?.task === "string" ? input.task.trim() : "";
    if (!task) return { ok: false, output: null, error: "task is required: write the complete question for the helper." };
    if (task.length > MAX_TASK_LENGTH) return { ok: false, output: null, error: `task is too long (max ${MAX_TASK_LENGTH} characters).` };
    if (!ctx.runSubagent) return { ok: false, output: null, error: "Helpers are not available in this session." };
    const outcome = await ctx.runSubagent(task);
    if (!outcome.ok) return { ok: false, output: null, error: outcome.error };
    const truncated = outcome.text.length > MAX_FINDINGS_CHARS;
    return { ok: true, output: { findings: truncated ? outcome.text.slice(0, MAX_FINDINGS_CHARS) : outcome.text, toolCalls: outcome.toolCalls, truncated } };
  },
};
