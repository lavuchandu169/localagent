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

  // Security audit finding (code-review-and-quality pass): content.replace(oldString, newString)
  // interprets special $-replacement-pattern sequences in newString ($$, $&,
  // $`, $', $1..) even though oldString is a plain string, not a RegExp —
  // per String.prototype.replace()'s own documented behavior, that
  // interpretation always applies to the second argument. A model-issued
  // edit whose replacement text happens to contain one of these sequences
  // (shell $$, jQuery $', etc.) would have it silently mangled instead of
  // inserted literally. split(oldString).join(newString) never interprets
  // any pattern in its second argument, and correctly handles exactly one
  // occurrence the same way a true single-replace would (by this point
  // either occurrences === 1, or replaceAll is true — both are correct with
  // this single implementation, so there is no need for the two branches
  // split/join already replaced to keep as a ternary).
  const newContent = content.split(oldString).join(newString);
  return { ok: true, newContent };
}
