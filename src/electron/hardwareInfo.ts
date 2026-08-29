import type { EmbeddedModelId } from "../models.js";

export interface HardwareInfo {
  totalRamBytes: number;
  gpu: string | false;
  vramBytes: number;
}

/**
 * Rough RAM-based sizing, not a guarantee: it doesn't know what else is
 * running and actual peak memory varies a bit by quantization. Meant as a
 * pre-selected default the user can still override, not a hard limit.
 * Recommends among the coding models only — coding is this app's primary
 * path; the general-chat models are there to pick manually, not
 * auto-recommended.
 */
export function recommendModel(info: HardwareInfo): EmbeddedModelId {
  const gb = info.totalRamBytes / 1024 ** 3;
  if (gb >= 16) return "qwen-coder-7b";
  if (gb >= 8) return "qwen-coder-3b";
  return "qwen-coder-1.5b";
}

export async function detectHardware(): Promise<HardwareInfo> {
  const { getLlama } = await import("node-llama-cpp");
  const llama = await getLlama();
  const [ram, vram] = await Promise.all([llama.getRamState(), llama.getVramState()]);
  return { totalRamBytes: ram.total, gpu: llama.gpu, vramBytes: vram.total };
}
