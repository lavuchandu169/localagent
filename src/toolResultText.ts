/**
 * How much of one tool result the model sees.
 *
 * Every result was cut at 6,000 characters for every model. Tests with
 * real models showed two problems. The cut removed the fields that say
 * a file was cut (they come after the content), so a model counted the
 * functions in a third of a file and reported that as the total. And a
 * model with a large context never saw more than 6,000 characters of a
 * file, although read_file is built to return 20,000.
 */

/** The limit when the model's context size is not known, as for the cloud providers. Holds a full read_file result. */
export const LARGE_RESULT_CHARS = 24_000;
const SMALLEST_RESULT_CHARS = 3_000;
/** One result may use this part of a known context window. */
const WINDOW_SHARE = 0.25;
const CHARS_PER_TOKEN = 3;

/** The character limit for one tool result, from the model's context size in tokens. */
export function toolResultBudgetChars(contextWindowTokens: number | undefined): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) return LARGE_RESULT_CHARS;
  const share = Math.floor(contextWindowTokens * WINDOW_SHARE * CHARS_PER_TOKEN);
  return Math.max(SMALLEST_RESULT_CHARS, Math.min(LARGE_RESULT_CHARS, share));
}

/** The text of a tool result for the conversation. A result that is too long is cut, and the text says so. */
export function toolResultText(result: unknown, budgetChars: number): string {
  const text = JSON.stringify(result);
  if (text.length <= budgetChars) return text;
  const notice = (kept: number) =>
    `\n[This result was cut: it has ${text.length} characters and only the first ${kept} are shown. Ask for less at a time, for example read_file with offset and limit, or a narrower search.]`;
  const kept = Math.max(0, budgetChars - notice(budgetChars).length);
  return text.slice(0, kept) + notice(kept);
}
