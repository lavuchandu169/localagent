import { ANTHROPIC_PRICING, estimateCostUsd } from "../anthropicPricing.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("estimateCostUsd:");

{
  const cost = estimateCostUsd("claude-sonnet-5", 1_000_000, 0);
  check("Sonnet 5: 1M input tokens alone costs exactly its input-per-million rate", cost === ANTHROPIC_PRICING["claude-sonnet-5"]!.inputPerMillion);
}

{
  const cost = estimateCostUsd("claude-sonnet-5", 0, 1_000_000);
  check("Sonnet 5: 1M output tokens alone costs exactly its output-per-million rate", cost === ANTHROPIC_PRICING["claude-sonnet-5"]!.outputPerMillion);
}

{
  const cost = estimateCostUsd("claude-opus-5", 500_000, 100_000);
  const expected = (500_000 / 1_000_000) * ANTHROPIC_PRICING["claude-opus-5"]!.inputPerMillion + (100_000 / 1_000_000) * ANTHROPIC_PRICING["claude-opus-5"]!.outputPerMillion;
  check("Opus 5: input and output combine additively", cost === expected);
}

{
  const cost = estimateCostUsd("claude-haiku-4-5", 250_000, 50_000);
  const expected = (250_000 / 1_000_000) * ANTHROPIC_PRICING["claude-haiku-4-5"]!.inputPerMillion + (50_000 / 1_000_000) * ANTHROPIC_PRICING["claude-haiku-4-5"]!.outputPerMillion;
  check("Haiku 4.5: input and output combine additively", cost === expected);
}

{
  check("Opus 5 costs more per token than Sonnet 5, which costs more than Haiku 4.5 (sanity-checks the table itself, not just the arithmetic)",
    ANTHROPIC_PRICING["claude-opus-5"]!.inputPerMillion > ANTHROPIC_PRICING["claude-sonnet-5"]!.inputPerMillion &&
    ANTHROPIC_PRICING["claude-sonnet-5"]!.inputPerMillion > ANTHROPIC_PRICING["claude-haiku-4-5"]!.inputPerMillion
  );
}

{
  check("zero tokens of either kind costs exactly zero", estimateCostUsd("claude-sonnet-5", 0, 0) === 0);
}

{
  check("an unrecognized model id returns null rather than guessing a price", estimateCostUsd("some-future-claude-model", 1000, 1000) === null);
}

{
  check("an empty model id also returns null, not a crash", estimateCostUsd("", 1000, 1000) === null);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
