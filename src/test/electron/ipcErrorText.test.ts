import { ipcErrorText } from "../../electron/renderer/ipcErrorText.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("ipcErrorText:");
const wrapped = new Error(
  "Error invoking remote method 'agent:start-session': Error: Could not start the model. The model download stopped (HTTP 403) after 3 attempts. Try again: the download continues from the part that is already saved."
);
check("the wrapper of the main process is removed", ipcErrorText(wrapped).startsWith('Could not start the model. The model download stopped (HTTP 403)'));
check("the rest of the message is kept whole", ipcErrorText(wrapped).endsWith("already saved."));
check("another error class in the wrapper is removed too", ipcErrorText(new Error("Error invoking remote method 'x:y': TypeError: bad value")) === "bad value");
check("a wrapper with no error class is removed", ipcErrorText(new Error("Error invoking remote method 'x:y': Download cancelled.")) === "Download cancelled.");
check("a plain message is not changed", ipcErrorText(new Error("Download cancelled.")) === "Download cancelled.");
check("the wrapper text in the middle of a message is not touched", ipcErrorText(new Error("Note: Error invoking remote method 'a': b")) === "Note: Error invoking remote method 'a': b");
check("a value that is not an error is shown as text", ipcErrorText("plain") === "plain" && ipcErrorText(null) === "null");

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
