import { applyOldStringReplace } from "../../editResolution.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("applyOldStringReplace: a unique match is replaced:");
{
  const result = applyOldStringReplace("line1\nline2\nline3\n", "line2", "replaced", false);
  check("reports success", result.ok === true);
  check("the match is replaced, everything else untouched", result.ok && result.newContent === "line1\nreplaced\nline3\n");
}

console.log("\napplyOldStringReplace: old_string not found in the file:");
{
  const result = applyOldStringReplace("line1\nline2\n", "nope", "x", false);
  check("reports failure, not a silent no-op", result.ok === false);
  check("the error names the real problem", !result.ok && result.error.toLowerCase().includes("not found"));
}

console.log("\napplyOldStringReplace: old_string matches more than once, replace_all not set:");
{
  const result = applyOldStringReplace("foo\nfoo\nfoo\n", "foo", "bar", false);
  check("refuses an ambiguous match instead of guessing which one", result.ok === false);
  check("the error says how many locations matched", !result.ok && result.error.includes("3"));
}

console.log("\napplyOldStringReplace: old_string matches more than once, replace_all: true:");
{
  const result = applyOldStringReplace("foo\nfoo\nfoo\n", "foo", "bar", true);
  check("replaces every occurrence", result.ok === true);
  check("every occurrence is actually replaced", result.ok && result.newContent === "bar\nbar\nbar\n");
}

console.log("\napplyOldStringReplace: replace_all: true with exactly one match still works (not an error just because it's the flag):");
{
  const result = applyOldStringReplace("only once\n", "once", "twice", true);
  check("a single match with replace_all still succeeds", result.ok === true);
  check("the content is correctly replaced", result.ok && result.newContent === "only twice\n");
}

console.log("\napplyOldStringReplace: an empty old_string is refused, never a match-everywhere replace:");
{
  const result = applyOldStringReplace("line1\nline2\n", "", "x", true);
  check("refuses an empty old_string", result.ok === false);
}

console.log("\napplyOldStringReplace: a multi-line old_string (a real block, not just one line) works:");
{
  const content = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
  const result = applyOldStringReplace(content, "function a() {\n  return 1;\n}", "function a() {\n  return 100;\n}", false);
  check("a multi-line block replace succeeds", result.ok === true);
  check(
    "only the targeted block changed, the rest of the file is untouched",
    result.ok && result.newContent === "function a() {\n  return 100;\n}\n\nfunction b() {\n  return 2;\n}\n"
  );
}

console.log(
  "\napplyOldStringReplace: a single match whose new_string contains $-replacement-pattern sequences inserts them literally, not expanded (security audit — code-review-and-quality pass):"
);
{
  // String.prototype.replace() interprets special replacement patterns in
  // its SECOND argument even when the first argument is a plain string,
  // not a RegExp ($$  -> literal $, $& -> the matched text, $` / $' ->
  // text before/after the match, $1.. -> capture groups). A model-issued
  // edit inserting shell ($$, a PID in sh/bash/Perl/PHP), jQuery ($'),
  // or any other code containing these sequences would have its new_string
  // silently mangled instead of inserted as the exact bytes requested.
  const content = "const old = 1;\n";
  const result = applyOldStringReplace(content, "const old = 1;", "const price = \"$$5\";", false);
  check("a literal $$ in new_string is not collapsed to a single $", result.ok === true && result.newContent === 'const price = "$$5";\n');
}
{
  const content = "placeholder\n";
  const result = applyOldStringReplace(content, "placeholder", "echo $& done", false);
  check("a literal $& in new_string is not expanded to the matched text", result.ok === true && result.newContent === "echo $& done\n");
}
{
  // The replaceAll path (split/join) was already unaffected by this bug —
  // pin it here so the fix can't accidentally be applied asymmetrically.
  const content = "x\nx\n";
  const result = applyOldStringReplace(content, "x", "$$", true);
  check("replace_all with a literal $$ in new_string is also not collapsed (regression guard, was already correct)", result.ok === true && result.newContent === "$$\n$$\n");
}

console.log("\napplyOldStringReplace: old_string containing regex-special characters is matched literally, not as a regex:");
{
  const content = "const re = /a.b+c*/;\nconst other = 1;\n";
  const result = applyOldStringReplace(content, "/a.b+c*/", "/x.y+z*/", false);
  check("regex metacharacters in old_string are treated as literal text", result.ok === true);
  check("the literal replacement happened correctly", result.ok && result.newContent === "const re = /x.y+z*/;\nconst other = 1;\n");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
