import { EMBEDDED_MODELS, type EmbeddedModelId } from "../models.js";

/** Which curated embedded models are already downloaded to node-llama-cpp's cache — checked with download disabled, so this never triggers a fetch. */
export async function checkCachedModels(): Promise<Record<EmbeddedModelId, boolean>> {
  const { resolveModelFile } = await import("node-llama-cpp");
  const ids = Object.keys(EMBEDDED_MODELS) as EmbeddedModelId[];
  const result = {} as Record<EmbeddedModelId, boolean>;

  for (const id of ids) {
    try {
      await resolveModelFile(EMBEDDED_MODELS[id].uri, { download: false });
      result[id] = true;
    } catch {
      result[id] = false;
    }
  }

  return result;
}
