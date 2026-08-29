// Curated GGUF models for the embedded runtime (Section 22/23). Curated
// rather than an arbitrary HF path so quantization and tool-call-format
// compatibility are known-good. Resolved/downloaded via node-llama-cpp's
// resolveModelFile(), cached in its default global models directory
// (~/.node-llama-cpp/models) so repeat runs don't re-download.

export type ModelCategory = "coding" | "chat";

export type EmbeddedModelId =
  | "qwen-coder-1.5b"
  | "qwen-coder-3b"
  | "qwen-coder-7b"
  | "qwen-3b"
  | "llama-3.2-3b"
  | "phi-3.5-mini"
  | "mistral-7b";

export interface EmbeddedModelInfo {
  uri: string;
  /** The model's real name — always shown as-is in the UI, never behind a generic "small/medium/large" label. */
  name: string;
  quant: string;
  category: ModelCategory;
  /** Plain-language speed/memory/quality note shown alongside the name. */
  sizeNote: string;
}

export const EMBEDDED_MODELS: Record<EmbeddedModelId, EmbeddedModelInfo> = {
  "qwen-coder-1.5b": {
    uri: "hf:Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
    name: "Qwen2.5-Coder 1.5B Instruct",
    quant: "Q4_K_M",
    category: "coding",
    sizeNote: "fastest, lowest memory — default",
  },
  "qwen-coder-3b": {
    uri: "hf:Qwen/Qwen2.5-Coder-3B-Instruct-GGUF:Q4_K_M",
    name: "Qwen2.5-Coder 3B Instruct",
    quant: "Q4_K_M",
    category: "coding",
    sizeNote: "better quality, more memory",
  },
  "qwen-coder-7b": {
    uri: "hf:Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M",
    name: "Qwen2.5-Coder 7B Instruct",
    quant: "Q4_K_M",
    category: "coding",
    sizeNote: "best quality, needs a capable machine",
  },
  "qwen-3b": {
    uri: "hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M",
    name: "Qwen2.5 3B Instruct",
    quant: "Q4_K_M",
    category: "chat",
    sizeNote: "fast, general-purpose",
  },
  "llama-3.2-3b": {
    uri: "hf:bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M",
    name: "Llama 3.2 3B Instruct",
    quant: "Q4_K_M",
    category: "chat",
    sizeNote: "fast, general-purpose",
  },
  "phi-3.5-mini": {
    uri: "hf:bartowski/Phi-3.5-mini-instruct-GGUF:Q4_K_M",
    name: "Phi-3.5 Mini Instruct",
    quant: "Q4_K_M",
    category: "chat",
    sizeNote: "compact, strong reasoning for its size",
  },
  "mistral-7b": {
    uri: "hf:bartowski/Mistral-7B-Instruct-v0.3-GGUF:Q4_K_M",
    name: "Mistral 7B Instruct v0.3",
    quant: "Q4_K_M",
    category: "chat",
    sizeNote: "best quality, needs a capable machine",
  },
};

export const DEFAULT_EMBEDDED_MODEL: EmbeddedModelId = "qwen-coder-1.5b";

export function isEmbeddedModelId(value: string): value is EmbeddedModelId {
  return Object.hasOwn(EMBEDDED_MODELS, value);
}

/** Full display label, e.g. "Qwen2.5-Coder 1.5B Instruct (Q4_K_M) — fastest, lowest memory — default". Used wherever the running model needs to be shown in full (the active-session badge, CLI startup logging). */
export function describeEmbeddedModel(id: EmbeddedModelId): string {
  const info = EMBEDDED_MODELS[id];
  return `${info.name} (${info.quant}) — ${info.sizeNote}`;
}
