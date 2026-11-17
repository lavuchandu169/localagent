/**
 * The definitions in a whole file, found with simple patterns.
 *
 * read_file sends this with a file that it can show only in part. Real
 * local models counted the functions in the first third of a file and
 * gave that as the total, whatever the result said about missing lines.
 * A count of the whole file, made by the app, does not depend on the
 * model reading every part. The names and line numbers also tell the
 * model which offset to read for a definition it needs.
 *
 * The patterns are approximate on purpose: no parser, any language.
 */

export interface FileOutline {
  /** Number of function, method and class definitions found in the whole file. */
  definitions: number;
  functions: number;
  classes: number;
  /** "name (line N)" for the definitions from namesFromLine on, as many as fit. */
  names: string[];
  /** True when names does not list every definition. */
  namesCut: boolean;
}

const FUNCTION_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, // JS/TS
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, // arrow function
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/, // function expression
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, // Python
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, // Go
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, // Rust
];
const CLASS_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, // JS/TS, Python, Java-like
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, // Rust
  /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, // Go
];

/**
 * Outlines a file's text. The counts cover the whole file. The names
 * list starts at namesFromLine, so that it can name what comes after a
 * part that the model already has, and maxNamesChars limits its length.
 */
export function outlineFile(content: string, maxNamesChars = 900, namesFromLine = 1): FileOutline {
  const names: string[] = [];
  let functions = 0;
  let classes = 0;
  let used = 0;
  let namesCut = false;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue; // a minified or data line
    let name: string | undefined;
    const asFunction = FUNCTION_PATTERNS.map((p) => p.exec(line)).find(Boolean);
    if (asFunction) {
      functions++;
      name = asFunction[1];
    } else {
      const asClass = CLASS_PATTERNS.map((p) => p.exec(line)).find(Boolean);
      if (asClass) {
        classes++;
        name = asClass[1];
      }
    }
    if (!name || i + 1 < namesFromLine) continue;
    const entry = `${name} (line ${i + 1})`;
    if (!namesCut && used + entry.length + 4 <= maxNamesChars) {
      names.push(entry);
      used += entry.length + 4;
    } else {
      namesCut = true;
    }
  }
  return { definitions: functions + classes, functions, classes, names, namesCut };
}
