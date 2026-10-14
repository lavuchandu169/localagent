import { loadSidebarCollapsed, saveSidebarCollapsed, SIDEBAR_COLLAPSED_KEY } from "../../electron/renderer/sidebarToggle.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = { ...initial };
  return {
    getItem: (key: string) => (key in data ? data[key]! : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    removeItem: (key: string) => {
      delete data[key];
    },
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

console.log("loadSidebarCollapsed:");
{
  const storage = fakeStorage();
  check("defaults to expanded (false) when nothing is stored yet", loadSidebarCollapsed(storage) === false);
}
{
  const storage = fakeStorage({ [SIDEBAR_COLLAPSED_KEY]: "1" });
  check("reads back a stored collapsed state as true", loadSidebarCollapsed(storage) === true);
}
{
  const storage = fakeStorage({ [SIDEBAR_COLLAPSED_KEY]: "0" });
  check("reads back a stored expanded state as false", loadSidebarCollapsed(storage) === false);
}
{
  const storage: Pick<Storage, "getItem"> = {
    getItem: () => {
      throw new Error("blocked");
    },
  };
  check("a storage read that throws falls back to expanded (false), not an error", loadSidebarCollapsed(storage) === false);
}

console.log("\nsaveSidebarCollapsed:");
{
  const storage = fakeStorage();
  saveSidebarCollapsed(storage, true);
  check("saving true is read back as true", loadSidebarCollapsed(storage) === true);
}
{
  const storage = fakeStorage({ [SIDEBAR_COLLAPSED_KEY]: "1" });
  saveSidebarCollapsed(storage, false);
  check("saving false overwrites a previously-stored true", loadSidebarCollapsed(storage) === false);
}
{
  const storage: Pick<Storage, "setItem"> = {
    setItem: () => {
      throw new Error("blocked");
    },
  };
  let threw = false;
  try {
    saveSidebarCollapsed(storage, true);
  } catch {
    threw = true;
  }
  check("a storage write that throws is swallowed (best-effort), never bubbles up", !threw);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
