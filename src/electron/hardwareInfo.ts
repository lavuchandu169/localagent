import type { EmbeddedModelId } from "../models.js";

export interface HardwareInfo {
  totalRamBytes: number;
  gpu: string | false;
  vramBytes: number;
}

// Correctness finding (code-review-and-quality pass): comparing against
// an exact round number (8, 16) almost never actually fires for the real
// machine that number is meant to describe — the OS reports total RAM
// minus whatever firmware/integrated-GPU/kernel reservations already
// carved out before anything else ever sees it, so an advertised "16GB"
// machine commonly reports a totalRamBytes a few hundred MB under the
// true 16 * 1024³. Comparing against the round number exactly silently
// bucketed real 8GB/16GB machines down into the tier below the one they
// were actually meant to get. This margin is a flat GB amount (reserved
// memory is roughly constant overhead, not proportional to total RAM)
// generous enough to cover typical firmware/GPU reservations without
// blurring genuinely different tiers together.
const RAM_THRESHOLD_TOLERANCE_GB = 0.75;

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
  if (gb >= 16 - RAM_THRESHOLD_TOLERANCE_GB) return "qwen-coder-7b";
  if (gb >= 8 - RAM_THRESHOLD_TOLERANCE_GB) return "qwen-coder-3b";
  return "qwen-coder-1.5b";
}

export async function detectHardware(): Promise<HardwareInfo> {
  const { getLlama } = await import("node-llama-cpp");
  const llama = await getLlama();
  const [ram, vram] = await Promise.all([llama.getRamState(), llama.getVramState()]);
  return { totalRamBytes: ram.total, gpu: llama.gpu, vramBytes: vram.total };
}
