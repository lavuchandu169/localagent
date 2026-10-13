import type { Tool, ToolContext } from "../types.js";

/**
 * Deferred-minor finding M7: `load_skill` is a name the model sees in
 * its own conversation history (the synthetic tool_calls autoLoadSkills
 * pushes when a skill auto-matches) but was never given a real schema
 * for — a weaker local model imitating a pattern it just saw could
 * plausibly try calling it itself on a later turn. Without a real tool
 * registered under this name, that attempt hit a bare "Unknown tool:
 * load_skill" error and wasted a turn. This registers an inert READ
 * tool under the same name: calling it directly does nothing (skills
 * only ever load automatically, via autoLoadSkills, never on model
 * request) but the model gets a clear, harmless answer instead of an
 * error.
 */
export const loadSkillTool: Tool<Record<string, never>, { message: string }> = {
  name: "load_skill",
  description: "Skills load automatically before each task based on what the task is about — you never need to call this yourself.",
  permission: "READ",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, _ctx: ToolContext) {
    return {
      ok: true,
      output: { message: "Skills load automatically before each task; calling this tool directly has no effect." },
    };
  },
};
