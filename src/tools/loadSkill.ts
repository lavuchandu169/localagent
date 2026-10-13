/**
 * Deferred-minor finding M7, narrowed after a live-tested regression:
 * `load_skill` is a name the model sees in its own conversation history
 * (the synthetic tool_calls autoLoadSkills pushes when a skill
 * auto-matches), not a tool it should ever be OFFERED to call itself.
 *
 * An earlier version of this fix registered `load_skill` as a real,
 * always-listed tool — fixing the narrow "Unknown tool" error, but
 * creating a worse problem: a 3B model, seeing "load_skill" sitting in
 * its own tool list on an ORDINARY task where no skill had even
 * matched, called it out of curiosity on its very first turn, got back
 * this message, and then parroted it back as its entire answer instead
 * of addressing the actual task — a full derailment, confirmed live.
 *
 * This message is now used only as a dispatch-level fallback (see
 * agent.ts's "unknown tool" branch) for a model imitating the auto-
 * injected pattern it just saw in THIS conversation — never advertised
 * in `tools.toSchema()`, so a model has no way to discover or choose it
 * on a task where it was never relevant.
 */
export const LOAD_SKILL_FALLBACK_MESSAGE = "Skills load automatically before each task; calling this tool directly has no effect.";
