// src/electron/renderer/overlayPanel.ts
// Shared open/close animation for every full-screen overlay panel (About,
// Settings, MCP servers, Keys, Fallback, command palette) — see the
// `.closing` rules in styles.css for the actual animation. Kept as its own
// leaf module rather than a renderer.ts export: freellmapiPanel.ts and
// freellmapiFallbackPanel.ts need it too, and renderer.ts is what imports
// them, so a renderer.ts export would be a circular import.

// Covers the 140ms CSS closing animation plus slack, and is also what
// fires when prefers-reduced-motion disables that animation outright (the
// CSS rule removes the animation, so `animationend` never fires on its
// own) — either way, the panel must still actually close.
const CLOSE_ANIMATION_FALLBACK_MS = 200;

export function openOverlayPanel(panel: HTMLElement): void {
  panel.classList.remove("closing");
  panel.hidden = false;
}

/** Plays the panel's closing animation, then sets `hidden` once it ends
 * (or after a fallback timeout — see CLOSE_ANIMATION_FALLBACK_MS). Safe to
 * call on an already-hidden panel. */
export function closeOverlayPanel(panel: HTMLElement): void {
  if (panel.hidden) return;
  panel.classList.add("closing");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    panel.hidden = true;
    panel.classList.remove("closing");
  };
  panel.addEventListener("animationend", finish, { once: true });
  setTimeout(finish, CLOSE_ANIMATION_FALLBACK_MS);
}
