import { isEmbeddedModelId } from "../models.js";
import type { Role } from "../organization.js";
import type { ProviderConfig } from "./sessionRegistry.js";

/**
 * Mirrors the cloud-model id lists `deriveProviderConfigFromForm` uses in
 * the renderer (renderer.ts) — kept as a small, separate copy rather than
 * importing from the renderer (which also pulls in live DOM element
 * references that don't exist outside a page) or refactoring that
 * existing, working function to extract a shared helper. If the
 * renderer's own lists change, these need updating too; that coupling is
 * accepted here rather than risking a refactor of session-start code
 * this slice doesn't otherwise need to touch.
 */
const ANTHROPIC_MODELS = new Set(["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"]);
const OPENAI_MODELS = new Set(["gpt-5.5", "gpt-5.6-sol", "gpt-5-nano"]);
const GEMINI_MODELS = new Set(["gemini-3.8-flash", "gemini-3.1-pro", "gemini-3.5-flash-lite"]);
const FREELLMAPI_MODEL_ID = "freellmapi-auto";

/**
 * Resolves a role's plain `model` string into the real `ProviderConfig`
 * a session actually starts with. Deliberately narrower than the
 * renderer's own `deriveProviderConfigFromForm`: custom-server and
 * custom-embedded both need extra fields (a base URL, an external model
 * name, a GGUF URI) that `Role` doesn't carry, since nothing has asked
 * for organization roles to point at a custom server or a custom HF GGUF
 * yet — refused with a clear error rather than silently guessing wrong
 * values for those fields.
 */
export function resolveRoleProviderConfig(role: Role): { ok: true; config: ProviderConfig } | { ok: false; error: string } {
  const modelId = role.model;
  if (ANTHROPIC_MODELS.has(modelId)) return { ok: true, config: { kind: "anthropic", model: modelId } };
  if (OPENAI_MODELS.has(modelId)) return { ok: true, config: { kind: "openai", model: modelId } };
  if (GEMINI_MODELS.has(modelId)) return { ok: true, config: { kind: "gemini", model: modelId } };
  if (modelId === FREELLMAPI_MODEL_ID) return { ok: true, config: { kind: "freellmapi" } };
  if (isEmbeddedModelId(modelId)) return { ok: true, config: { kind: "embedded", size: modelId } };
  return {
    ok: false,
    error: `Role "${role.title}" has an unrecognized model id "${modelId}" — custom servers and custom embedded models aren't supported for organization roles yet; pick one of the built-in model ids.`,
  };
}
