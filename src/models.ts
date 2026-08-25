// Curated GGUF models for the embedded runtime (Section 22/23). Curated
// rather than an arbitrary HF path so quantization and tool-call-format
// compatibility are known-good. Resolved/downloaded via node-llama-cpp's
// resolveModelFile(), cached in its default global models directory
// (~/.node-llama-cpp/models) so repeat runs don't re-download.

export type EmbeddedModelSize = "small" | "medium" | "large";

export const EMBEDDED_MODELS: Record<EmbeddedModelSize, { uri: string; description: string }> = {
  small: {
    uri: "hf:Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
    description: "Qwen2.5-Coder 1.5B Instruct (Q4_K_M) — fast, low memory, default",
  },
  medium: {
    uri: "hf:Qwen/Qwen2.5-Coder-3B-Instruct-GGUF:Q4_K_M",
    description: "Qwen2.5-Coder 3B Instruct (Q4_K_M) — better quality, more memory",
  },
  large: {
    uri: "hf:Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M",
    description: "Qwen2.5-Coder 7B Instruct (Q4_K_M) — best quality, needs a capable machine",
  },
};

export function isEmbeddedModelSize(value: string): value is EmbeddedModelSize {
  return value === "small" || value === "medium" || value === "large";
}
