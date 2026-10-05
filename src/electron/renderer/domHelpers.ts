/** Looks up a required element by id, throwing immediately (rather than
 * returning null and deferring the crash to whatever first touches it)
 * if the id doesn't exist — every caller treats these as always-present
 * fixtures of index.html, not optional. */
export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}
