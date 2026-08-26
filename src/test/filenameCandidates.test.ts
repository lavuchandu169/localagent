import { extractFilenameCandidates } from "../filenameCandidates.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("Filename candidate extraction:");

check(
  "extracts a single named file from a task sentence",
  JSON.stringify(extractFilenameCandidates("fix the bug in app.py")) === JSON.stringify(["app.py"])
);
check(
  "extracts multiple named files",
  JSON.stringify(extractFilenameCandidates("compare index.html and styles.css")) === JSON.stringify(["index.html", "styles.css"])
);
check("dedupes repeated mentions of the same file", JSON.stringify(extractFilenameCandidates("read app.py then fix app.py")) === JSON.stringify(["app.py"]));
check("returns nothing for prose with no filename", extractFilenameCandidates("what does this project do").length === 0);
check("ignores a version-number-shaped token", extractFilenameCandidates("upgrade to Python 3.10 please").length === 0);
check(
  "still extracts a real filename alongside a version number",
  JSON.stringify(extractFilenameCandidates("update app.py for Python 3.10")) === JSON.stringify(["app.py"])
);

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
