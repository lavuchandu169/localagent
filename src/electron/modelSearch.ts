export interface HfModelSummary {
  id: string;
  downloads: number;
  likes: number;
}

export type HfSearchResult = { ok: true; results: HfModelSummary[] } | { ok: false; error: string };

/** Just enough of the real `fetch` response shape to search — injectable so tests never touch the network. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function defaultFetch(url: string) {
  return fetch(url);
}

/**
 * Searches Hugging Face's public model listing for GGUF repos matching a
 * keyword — backs the "Custom local model" search box (renderer.ts). Never
 * throws: any network failure or unexpected response shape comes back as
 * `{ ok: false, error }` so the UI can show it inline instead of crashing.
 */
export async function searchHuggingFaceGgufModels(query: string, fetchImpl: FetchLike = defaultFetch): Promise<HfSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: true, results: [] };

  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    const url = `https://huggingface.co/api/models?search=${encodeURIComponent(trimmed)}&filter=gguf&limit=20`;
    res = await fetchImpl(url);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    return { ok: false, error: `Hugging Face search failed (${res.status})` };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!Array.isArray(data)) {
    return { ok: false, error: "Unexpected response from Hugging Face" };
  }

  const results: HfModelSummary[] = data
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && typeof item.id === "string")
    .map((item) => ({
      id: item.id as string,
      downloads: typeof item.downloads === "number" ? item.downloads : 0,
      likes: typeof item.likes === "number" ? item.likes : 0,
    }));

  return { ok: true, results };
}
