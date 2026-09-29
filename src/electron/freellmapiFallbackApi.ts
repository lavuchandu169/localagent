// A thin, Electron-free HTTP client over the vendored FreeLLMAPI server's
// /api/fallback/* surface (vendor/freellmapi/server/src/routes/fallback.ts,
// read directly - not guessed). Same request()/auth/error-handling
// convention as freellmapiKeysApi.ts, whose FreellmapiKeysConn type this
// file reuses rather than redefining an identical {port, token} shape.
import type { FreellmapiKeysConn } from "./freellmapiKeysApi.js";

async function request<T>(conn: FreellmapiKeysConn, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${conn.port}/api/fallback${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${conn.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as any)?.error?.message ?? `Request failed: ${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return data as T;
}

export interface RoutingWeights {
  reliability: number;
  speed: number;
  intelligence: number;
}
export interface PeakHoursConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
  timezone: string;
}
export type RoutingStrategy = "priority" | "balanced" | "smartest" | "fastest" | "reliable" | "custom";
export type KeySelectionStrategy = "auto" | "least-remaining";
export interface RoutingScore {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  reliability: number;
  speed: number;
  intelligence: number;
  headroom: number;
  rateLimit: number;
  score: number;
  totalRequests: number;
}

/** GET /routing's real response shape - confirmed by reading getRoutingScores()
 * in router.ts directly: {peakHours, ...rest} spread plus four flattened
 * peakHours.* fields and cooldownCeilingMs appended. `weights` is null when
 * the active strategy is 'priority' (no weight vector applies). */
export interface RoutingSettings {
  strategy: RoutingStrategy;
  keySelectionStrategy: KeySelectionStrategy;
  weights: RoutingWeights | null;
  customWeights: RoutingWeights;
  exploreEnabled: boolean;
  peakAdjusted: boolean;
  scores: RoutingScore[];
  peakHoursAdjust: boolean;
  peakStartHour: number;
  peakEndHour: number;
  peakTimezone: string;
  cooldownCeilingMs: number | null;
}
export async function getRouting(conn: FreellmapiKeysConn): Promise<RoutingSettings> {
  return request(conn, "GET", "/routing");
}

export interface UpdateRoutingParams {
  strategy: RoutingStrategy;
  weights?: RoutingWeights;
  exploreEnabled?: boolean;
  peakHoursAdjust?: boolean;
  peakStartHour?: number;
  peakEndHour?: number;
  peakTimezone?: string;
  keySelectionStrategy?: KeySelectionStrategy;
  cooldownCeilingMs?: number | null;
}
/** PUT /routing's response is a DIFFERENT shape than GET's - confirmed by
 * reading the real handler directly: it echoes `presets` (the fixed preset
 * table) instead of `scores`/`customWeights`. Do not reuse RoutingSettings
 * here; that mismatch is exactly the class of bug the Keys panel's final
 * review caught in exportKeys(). */
export interface UpdateRoutingResult {
  strategy: RoutingStrategy;
  exploreEnabled: boolean;
  keySelectionStrategy: KeySelectionStrategy;
  presets: Record<string, RoutingWeights>;
  weights: RoutingWeights | null;
  peakAdjusted: boolean;
  peakHoursAdjust: boolean;
  peakStartHour: number;
  peakEndHour: number;
  peakTimezone: string;
  cooldownCeilingMs: number | null;
}
export async function updateRouting(conn: FreellmapiKeysConn, params: UpdateRoutingParams): Promise<UpdateRoutingResult> {
  return request(conn, "PUT", "/routing", params);
}

/** GET /'s real per-model row shape (global/no-profile mode only - confirmed
 * by reading the route handler's res.json(rows.map(...)) directly, all 34
 * fields). The panel only renders a useful subset of these; the client
 * returns the complete row so nothing is lost at the data layer. */
export interface FallbackModelRow {
  modelDbId: number;
  groupKey: string | null;
  canonicalId: string | null;
  groupLabel: string | null;
  priority: number;
  effectivePriority: number;
  penalty: number;
  rateLimitHits: number;
  enabled: boolean;
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number | null;
  speedRank: number | null;
  sizeLabel: string | null;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  contextWindow: number | null;
  monthlyTokenBudget: string | null;
  monthlyTokenBudgetTokens: number;
  supportsVision: boolean;
  supportsTools: boolean;
  source: "catalog" | "custom";
  keyId: number | null;
  keyLabel: string | null;
  endpointScope: string | null;
  qualifiedModelId: string;
  hasOverrides: boolean;
  overrideFields: string[];
  retiredUpstream: boolean;
  retiredReason: string | null;
  keyCount: number;
}
/** GET / returns a bare array, not {models: [...]} - same convention as
 * freellmapiKeysApi.ts's listKeys(), confirmed by reading the handler
 * directly (res.json(rows.map(...))). Global (no-profile) mode only - this
 * plan doesn't drive the profile-scoped variant. */
export async function getModelList(conn: FreellmapiKeysConn): Promise<FallbackModelRow[]> {
  return request(conn, "GET", "/");
}

export interface UpdateModelListEntry {
  modelDbId: number;
  priority: number;
  enabled: boolean;
}
export async function updateModelList(conn: FreellmapiKeysConn, entries: UpdateModelListEntry[]): Promise<{ success: true }> {
  return request(conn, "PUT", "/", entries);
}

export type SortPreset = "intelligence" | "speed" | "budget";
export async function sortModelList(conn: FreellmapiKeysConn, preset: SortPreset): Promise<{ success: true; preset: string }> {
  return request(conn, "POST", `/sort/${preset}`);
}
