import { resolveRoleProviderConfig } from "../../electron/organizationSession.js";
import type { Role } from "../../organization.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function role(model: string): Role {
  return { id: "r-1", title: "Engineer", responsibilities: "", reportsTo: null, model };
}

console.log("resolveRoleProviderConfig:");
{
  const anthropic = resolveRoleProviderConfig(role("claude-sonnet-5"));
  check("resolves a known Anthropic model id", anthropic.ok === true && anthropic.config.kind === "anthropic" && (anthropic.config as any).model === "claude-sonnet-5");

  const openai = resolveRoleProviderConfig(role("gpt-5.5"));
  check("resolves a known OpenAI model id", openai.ok === true && openai.config.kind === "openai" && (openai.config as any).model === "gpt-5.5");

  const gemini = resolveRoleProviderConfig(role("gemini-3.8-flash"));
  check("resolves a known Gemini model id", gemini.ok === true && gemini.config.kind === "gemini" && (gemini.config as any).model === "gemini-3.8-flash");

  const free = resolveRoleProviderConfig(role("freellmapi-auto"));
  check("resolves the free-tier router", free.ok === true && free.config.kind === "freellmapi");

  const embedded = resolveRoleProviderConfig(role("qwen-coder-7b"));
  check("resolves a known embedded model id", embedded.ok === true && embedded.config.kind === "embedded" && (embedded.config as any).size === "qwen-coder-7b");

  const unknown = resolveRoleProviderConfig(role("some-made-up-model"));
  check("an unrecognized model id is a clean error, not a throw or a silent wrong guess", unknown.ok === false);
  check("the error names the role and the bad model id", unknown.ok === false && unknown.error.includes("Engineer") && unknown.error.includes("some-made-up-model"));

  const customServer = resolveRoleProviderConfig(role("custom-server"));
  check(
    "custom-server is explicitly unsupported for roles (no baseUrl/model fields on Role to resolve it with) rather than silently guessed",
    customServer.ok === false
  );

  const customEmbedded = resolveRoleProviderConfig(role("custom-embedded"));
  check("custom-embedded is explicitly unsupported for roles for the same reason", customEmbedded.ok === false);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
