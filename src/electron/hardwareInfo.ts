import type { EmbeddedModelSize } from "../models.js";

export interface HardwareInfo {
  totalRamBytes: number;
  gpu: string | false;
  vramBytes: number;
}

/**
 * Rough RAM-based sizing, not a guarantee: it doesn't know what else is
 * running and actual peak memory varies a bit by quantization. Meant as a
 * pre-selected default the user can still override, not a hard limit.
 */
export function recommendModelSize(info: HardwareInfo): EmbeddedModelSize {
  const gb = info.totalRamBytes / 1024 ** 3;
  if (gb >= 16) return "large";
  if (gb >= 8) return "medium";
  return "small";
}

export async function detectHardware(): Promise<HardwareInfo> {
  const { getLlama } = await import("node-llama-cpp");
  const llama = await getLlama();
  const [ram, vram] = await Promise.all([llama.getRamState(), llama.getVramState()]);
  return { totalRamBytes: ram.total, gpu: llama.gpu, vramBytes: vram.total };
}
