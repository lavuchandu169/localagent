import type { PermissionMode, PermissionDecision, ToolCall, PermissionLevel } from "./types.js";

// Deterministic command risk classification (Section 16).
// The LLM's judgment is never trusted alone for safety-relevant decisions.
const SAFE_READ_COMMANDS = [/^pwd\b/, /^ls\b/, /^git status\b/, /^git log\b/, /^git diff\b/, /^cat\b/, /^npm test\b/, /^pytest\b/, /^node --version/];
const NETWORK_COMMANDS = [/^npm install\b/, /^pip install\b/, /^npm ci\b/, /^curl\b/, /^wget\b/];
const DESTRUCTIVE_COMMANDS = [/^rm\b/, /^git reset --hard/, /^git clean -fd/, /^sudo\b/, /^:>/, /^mkfs/];

export type CommandRisk = "SAFE_READ" | "NETWORK" | "DESTRUCTIVE" | "UNKNOWN";

export function classifyCommand(cmd: string): CommandRisk {
  const trimmed = cmd.trim();
  if (DESTRUCTIVE_COMMANDS.some((r) => r.test(trimmed))) return "DESTRUCTIVE";
  if (NETWORK_COMMANDS.some((r) => r.test(trimmed))) return "NETWORK";
  if (SAFE_READ_COMMANDS.some((r) => r.test(trimmed))) return "SAFE_READ";
  return "UNKNOWN";
}

export class PermissionEngine {
  constructor(private mode: PermissionMode) {}

  setMode(mode: PermissionMode) {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  evaluate(call: ToolCall, toolPermission: PermissionLevel): PermissionDecision {
    // READ tools are always allowed regardless of mode.
    if (toolPermission === "READ") return "ALLOW";

    if (this.mode === "PLAN") {
      // Plan mode may never write, execute, or touch network (Section 41).
      return "DENY";
    }

    if (toolPermission === "EXECUTE" && call.name === "run_command") {
      const risk = classifyCommand(String(call.arguments.command ?? ""));
      if (risk === "DESTRUCTIVE") return "ASK";
      if (risk === "NETWORK") return this.mode === "AUTO_SAFE" ? "ASK" : "ASK";
      if (risk === "SAFE_READ") return "ALLOW";
      return "ASK"; // UNKNOWN defaults to asking (Section 16).
    }

    if (toolPermission === "WRITE") {
      if (this.mode === "ACCEPT_EDITS" || this.mode === "AUTO_SAFE") return "ALLOW";
      return "ASK"; // DEFAULT mode asks before writes.
    }

    if (toolPermission === "DANGEROUS") return "ASK";
    if (toolPermission === "NETWORK") return "ASK";

    return "ASK";
  }
}
