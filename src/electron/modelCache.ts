import { EMBEDDED_MODELS, type EmbeddedModelSize } from "../models.js";

/** Which curated embedded models are already downloaded to node-llama-cpp's cache — checked with download disabled, so this never triggers a fetch. */
export async function checkCachedModels(): Promise<Record<EmbeddedModelSize, boolean>> {
  const { resolveModelFile } = await import("node-llama-cpp");
  const sizes = Object.keys(EMBEDDED_MODELS) as EmbeddedModelSize[];
  const result = {} as Record<EmbeddedModelSize, boolean>;

  for (const size of sizes) {
    try {
      await resolveModelFile(EMBEDDED_MODELS[size].uri, { download: false });
      result[size] = true;
    } catch {
      result[size] = false;
    }
  }

  return result;
}
