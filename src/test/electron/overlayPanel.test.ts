// overlayPanel.ts takes its HTMLElement as a parameter rather than looking
// one up via document.getElementById, so — unlike domHelpers.test.ts's
// byId — no global `document` needs installing here; a jsdom-created
// element is a real HTMLElement on its own.
import { JSDOM } from "jsdom";
import { openOverlayPanel, closeOverlayPanel } from "../../electron/renderer/overlayPanel.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log("openOverlayPanel:");
{
  const panel = dom.window.document.createElement("div");
  panel.hidden = true;
  panel.classList.add("closing");
  openOverlayPanel(panel);
  check("unhides the panel", !panel.hidden);
  check("clears any leftover closing class from a previous close", panel.classList.contains("closing") === false);
}

console.log("\ncloseOverlayPanel — animationend path:");
{
  const panel = dom.window.document.createElement("div");
  panel.hidden = false;
  closeOverlayPanel(panel);
  check("adds the closing class immediately, before the animation finishes", panel.classList.contains("closing"));
  check("does not hide the panel yet — the animation needs to actually play", !panel.hidden);

  panel.dispatchEvent(new dom.window.Event("animationend"));
  check("hides the panel once animationend fires", panel.hidden);
  check("removes the closing class once animationend fires", panel.classList.contains("closing") === false);
}

console.log("\ncloseOverlayPanel — reduced-motion / no-animation fallback:");
{
  const panel = dom.window.document.createElement("div");
  panel.hidden = false;
  closeOverlayPanel(panel);
  check("still not hidden immediately after closeOverlayPanel returns", !panel.hidden);

  // No animationend ever fires here (e.g. prefers-reduced-motion disables
  // the CSS animation outright) — only the fallback timeout should close it.
  await sleep(250);
  check("the fallback timeout hides the panel even with no animationend", panel.hidden);
}

console.log("\ncloseOverlayPanel — animationend firing after the fallback already ran:");
{
  const panel = dom.window.document.createElement("div");
  panel.hidden = false;
  closeOverlayPanel(panel);
  await sleep(250);
  check("fallback already closed it", panel.hidden);

  // A late animationend (once: true) must not throw or double-toggle state.
  let threw = false;
  try {
    panel.dispatchEvent(new dom.window.Event("animationend"));
  } catch {
    threw = true;
  }
  check("a late animationend after the fallback already fired is a harmless no-op", !threw && panel.hidden);
}

console.log("\ncloseOverlayPanel — already hidden:");
{
  const panel = dom.window.document.createElement("div");
  panel.hidden = true;
  closeOverlayPanel(panel);
  check("calling close on an already-hidden panel is a no-op (stays hidden)", panel.hidden);
  check("does not add the closing class for a panel that was never open", !panel.classList.contains("closing"));
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
