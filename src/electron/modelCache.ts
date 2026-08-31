import fs from "node:fs/promises";
import { EMBEDDED_MODELS, type EmbeddedModelId } from "../models.js";

/** Matches node-llama-cpp's resolveModelFile's `{download:false}` contract: resolves to the local path when cached, rejects when not. Injectable so tests don't need a real model cache or network access. */
export type ResolveModelFile = (uri: string, options: { download: false }) => Promise<string>;

async function defaultResolveModelFile(uri: string, options: { download: false }): Promise<string> {
  const { resolveModelFile } = await import("node-llama-cpp");
  return resolveModelFile(uri, options);
}

/** Which curated embedded models are already downloaded to node-llama-cpp's cache — checked with download disabled, so this never triggers a fetch. */
export async function checkCachedModels(resolve: ResolveModelFile = defaultResolveModelFile): Promise<Record<EmbeddedModelId, boolean>> {
  const ids = Object.keys(EMBEDDED_MODELS) as EmbeddedModelId[];
  const result = {} as Record<EmbeddedModelId, boolean>;

  for (const id of ids) {
    try {
      await resolve(EMBEDDED_MODELS[id].uri, { download: false });
      result[id] = true;
    } catch {
      result[id] = false;
    }
  }

  return result;
}

/**
 * Deletes a cached embedded model's file from disk, freeing the space it
 * took up. Lenient like the rest of this codebase's storage helpers
 * (loadGoogleSettings, etc.): a model that was never downloaded, or a file
 * that's already gone, or any other failure just returns `false` rather
 * than throwing — the caller only needs to know whether there's now
 * nothing cached for this id.
 */
export async function deleteModel(id: EmbeddedModelId, resolve: ResolveModelFile = defaultResolveModelFile): Promise<boolean> {
  try {
    const modelPath = await resolve(EMBEDDED_MODELS[id].uri, { download: false });
    await fs.unlink(modelPath);
    return true;
  } catch {
    return false;
  }
}
