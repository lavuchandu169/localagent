// domHelpers.ts is renderer-only DOM-wiring code with no prior test
// coverage (see this repo's broader accessibility/testing pass) — this is
// the first renderer test file, establishing the jsdom pattern that later
// renderer/panel test files reuse: construct a jsdom Document, install it
// as the global `document` byId() reads from, then exercise the module
// like any other unit under test.
import { JSDOM } from "jsdom";
import { byId, errorMessage, withBusyLabel } from "../../electron/renderer/domHelpers.js";

// byId reads the global `document` only when called, not at import time, so
// installing it here (after the static import above) is still soon enough.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as any).document = dom.window.document;

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("byId:");
{
  const el = dom.window.document.createElement("button");
  el.id = "real-button";
  dom.window.document.body.appendChild(el);
  check("finds an element that actually exists by id", byId<HTMLButtonElement>("real-button") === el);
}
{
  let threw = false;
  try {
    byId<HTMLElement>("does-not-exist");
  } catch (err) {
    threw = err instanceof Error && err.message === "Missing #does-not-exist";
  }
  check("throws immediately with the id in the message, rather than returning null", threw);
}

console.log("\nerrorMessage:");
{
  check("an Error's own message is returned unchanged", errorMessage(new Error("disk full")) === "disk full");
  check("a thrown string is stringified as-is", errorMessage("plain string") === "plain string");
  check("a thrown number is stringified", errorMessage(42) === "42");
  check("a thrown non-Error object falls back to String()", errorMessage({ code: "ENOENT" }) === String({ code: "ENOENT" }));
}

console.log("\nwithBusyLabel:");
{
  const btn = dom.window.document.createElement("button");
  btn.textContent = "Save";
  btn.disabled = false;

  let sawDisabled: unknown = null;
  let sawText: unknown = null;
  const result = await withBusyLabel(btn, "Saving…", async () => {
    sawDisabled = btn.disabled;
    sawText = btn.textContent;
    return "ok";
  });

  check("the callback's return value is passed through", result === "ok");
  check("the button was disabled while the callback ran", sawDisabled === true);
  check("the label was swapped to busyText while the callback ran", sawText === "Saving…");
  check("the button is re-enabled afterward", !btn.disabled);
  check("the original label is restored afterward", btn.textContent === "Save");
}

{
  const btn = dom.window.document.createElement("button");
  btn.textContent = "Remove";

  let threw = false;
  try {
    await withBusyLabel(btn, "Removing…", async () => {
      throw new Error("network error");
    });
  } catch {
    threw = true;
  }

  check("a thrown error from the callback propagates to the caller", threw);
  check("the button is still re-enabled even though the callback threw", !btn.disabled);
  check("the original label is still restored even though the callback threw", btn.textContent === "Remove");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
