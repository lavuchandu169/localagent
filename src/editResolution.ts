export type OldStringReplaceResult =
  | { ok: true; newContent: string }
  | { ok: false; error: string };

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let fromIndex = 0;
  while (true) {
    const idx = content.indexOf(needle, fromIndex);
    if (idx === -1) break;
    count++;
    fromIndex = idx + needle.length;
  }
  return count;
}

export function applyOldStringReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): OldStringReplaceResult {
  if (oldString === "") {
    return { ok: false, error: "old_string must not be empty." };
  }

  const occurrences = countOccurrences(content, oldString);
  if (occurrences === 0) {
    return { ok: false, error: "old_string was not found in the file." };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      error: `old_string matched ${occurrences} locations in the file — it must be unique, or pass replace_all: true to replace all of them.`,
    };
  }

  const newContent = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
  return { ok: true, newContent };
}
