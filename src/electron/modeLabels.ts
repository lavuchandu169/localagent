import type { PermissionMode } from "../types.js";

/** Plain-language copy for PermissionEngine's modes, named by what each one actually permits (permissions.ts). */
export const MODE_LABELS: Record<PermissionMode, { label: string; description: string }> = {
  PLAN: {
    label: "Read-only",
    description: "Nothing runs — every file edit or command is refused automatically.",
  },
  DEFAULT: {
    label: "Ask before every change",
    description: "Reading files runs freely; edits and commands wait for your approval.",
  },
  ACCEPT_EDITS: {
    label: "Auto-edit files",
    description: "File edits happen automatically; commands still wait for your approval.",
  },
  AUTO_SAFE: {
    label: "Auto-edit files (safe mode)",
    description: "Same as Auto-edit files in this build — safe-command auto-approval isn't wired up yet.",
  },
};
