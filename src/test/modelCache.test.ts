import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { checkCachedModels, deleteModel } from "../electron/modelCache.js";
import { DEFAULT_EMBEDDED_MODEL, EMBEDDED_MODELS, type EmbeddedModelId } from "../models.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

/** Fakes resolveModelFile's `{download:false}` contract: resolves to a real on-disk path when "cached", rejects when not — mirrors node-llama-cpp's actual documented behavior without touching the network or a real model cache. Keyed by model id, translated to the model's real URI internally so callers don't need to know the URI format. */
function fakeResolve(cachedPaths: Partial<Record<EmbeddedModelId, string>>) {
  const byUri = new Map<string, string>();
  for (const [id, p] of Object.entries(cachedPaths)) {
    byUri.set(EMBEDDED_MODELS[id as EmbeddedModelId].uri, p as string);
  }
  return async (uri: string, _options: { download: false }): Promise<string> => {
    const p = byUri.get(uri);
    if (!p) throw new Error(`not cached: ${uri}`);
    return p;
  };
}

console.log("checkCachedModels:");
async function runCheckCachedModelsTests() {
  const onlyDefaultCached = await checkCachedModels(fakeResolve({ [DEFAULT_EMBEDDED_MODEL]: "/fake/path/model.gguf" }));
  check("the cached model resolves true", onlyDefaultCached[DEFAULT_EMBEDDED_MODEL] === true);
  check(
    "an uncached model resolves false, not throwing",
    Object.entries(onlyDefaultCached).every(([id, cached]) => id === DEFAULT_EMBEDDED_MODEL || cached === false)
  );

  const noneCached = await checkCachedModels(fakeResolve({}));
  check("with nothing cached, every model resolves false", Object.values(noneCached).every((v) => v === false));
}
await runCheckCachedModelsTests();

console.log("\ndeleteModel:");
async function runDeleteModelTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-modelcache-test-"));
  const modelPath = path.join(dir, "fake-model.gguf");
  await fs.writeFile(modelPath, "not a real gguf, just needs to exist", "utf-8");

  const deleted = await deleteModel(DEFAULT_EMBEDDED_MODEL, fakeResolve({ [DEFAULT_EMBEDDED_MODEL]: modelPath }));
  check("deleting a cached model returns true", deleted === true);
  const stillThere = await fs
    .access(modelPath)
    .then(() => true)
    .catch(() => false);
  check("the file is actually gone from disk afterward", stillThere === false);

  const deletedAgain = await deleteModel(DEFAULT_EMBEDDED_MODEL, fakeResolve({ [DEFAULT_EMBEDDED_MODEL]: modelPath }));
  check("deleting an already-gone model returns false, not throwing", deletedAgain === false);

  const deletedUncached = await deleteModel(DEFAULT_EMBEDDED_MODEL, fakeResolve({}));
  check("deleting a model that was never cached returns false, not throwing", deletedUncached === false);

  await fs.rm(dir, { recursive: true, force: true });
}
await runDeleteModelTests();

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
