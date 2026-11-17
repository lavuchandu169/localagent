/**
 * The message of an error that came from the main process, without the
 * wrapper that Electron puts around it. Seen in the real app after a
 * failed model download: "Error invoking remote method
 * 'agent:start-session': Error: Could not start the model. ...". The
 * user needs only the part after the wrapper.
 */
export function ipcErrorText(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? message : String(err);
  return text.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, "");
}
