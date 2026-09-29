// A thin, Electron-free HTTP client over the vendored FreeLLMAPI server's
// /api/keys/* surface (vendor/freellmapi/server/src/routes/keys.ts, read
// directly - not guessed). Every request authenticates the same way the
// old dashboard window did: Authorization: Bearer <session token> (see
// vendor/freellmapi/server/src/middleware/requireAuth.ts). No Electron
// import here on purpose - testable under plain Node with a fake fetch,
// same pattern as providers/openaiCompatible.ts.

export interface FreellmapiKeysConn {
  port: number;
  token: string;
}

async function request<T>(conn: FreellmapiKeysConn, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${conn.port}/api/keys${path}`, {
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

export interface ProviderRow {
  platform: string;
  name: string;
  keyless: boolean;
  configured: boolean;
  keyCount: number;
  enabledKeyCount: number;
}
export interface ListProvidersResult {
  providers: ProviderRow[];
  summary: { total: number; configured: number; unconfigured: number };
}
export async function listProviders(conn: FreellmapiKeysConn): Promise<ListProvidersResult> {
  return request(conn, "GET", "/providers");
}

export interface KeyCooldown {
  modelId: string;
  expiresAtMs: number;
  remainingMs: number;
}
export interface CustomModelRow {
  id: number;
  kind: string;
  modelId: string;
  displayName: string;
  family: string | null;
}
export interface KeyRow {
  id: number;
  platform: string;
  label: string;
  maskedKey: string;
  baseUrl: string | null;
  monthlyRequestCap: number | null;
  monthlyTokenCap: number | null;
  status: string;
  enabled: boolean;
  keyless: boolean;
  exportable: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
  lastHealthError: string | null;
  modelScope: string[] | null;
  maskedProxyUrl: string;
  models?: CustomModelRow[];
  cooldowns: KeyCooldown[];
}
/** GET / returns a bare array, not {keys: [...]} - confirmed by reading the route handler directly. */
export async function listKeys(conn: FreellmapiKeysConn): Promise<KeyRow[]> {
  return request(conn, "GET", "/");
}

export interface AddKeyParams {
  platform: string;
  key?: string;
  label?: string;
  proxyUrl?: string;
}
export interface AddKeyResult {
  id: number;
  platform: string;
  label: string;
  maskedKey: string;
  status: string;
  enabled: boolean;
}
export async function addKey(conn: FreellmapiKeysConn, params: AddKeyParams): Promise<AddKeyResult> {
  return request(conn, "POST", "/", params);
}

export interface UpdateKeyParams {
  enabled?: boolean;
  label?: string;
  modelScope?: string[] | null;
  proxyUrl?: string;
  monthlyRequestCap?: number;
  monthlyTokenCap?: number;
  key?: string;
}
export async function updateKey(conn: FreellmapiKeysConn, id: number, params: UpdateKeyParams): Promise<{ success: true }> {
  return request(conn, "PATCH", `/${id}`, params);
}

export async function removeKey(conn: FreellmapiKeysConn, id: number): Promise<{ success: true }> {
  return request(conn, "DELETE", `/${id}`);
}

export async function clearCooldown(conn: FreellmapiKeysConn, id: number): Promise<{ cleared: number }> {
  return request(conn, "DELETE", `/${id}/cooldowns`);
}

/**
 * Skips the dashboard's usual password re-verification: the vendored
 * server exempts loopback requests from its own desktop build
 * (process.env.FREEAPI_DESKTOP === '1', set by
 * vendor/freellmapi/desktop/src/server-host.ts's startServer(), which
 * freellmapiHost.ts calls in-process) - confirmed by reading
 * skipsReauth() in vendor/freellmapi/server/src/routes/keys.ts directly.
 * No x-reauth-password header is sent or needed here.
 */
export async function revealKey(conn: FreellmapiKeysConn, id: number): Promise<{ key: string }> {
  return request(conn, "POST", `/${id}/reveal`);
}

export interface ImportPreviewEntry {
  keyName: string;
  keyValue: string;
  detectedPlatform: string | null;
  prefix: string;
  baseUrl?: string;
  models?: Array<{ id: string; supportsTools?: boolean; supportsVision?: boolean }>;
  isDuplicate: boolean;
}
export interface ImportPreviewResult {
  keys: ImportPreviewEntry[];
  total: number;
  skipped: string[];
  duplicates: number;
}
/**
 * Multipart upload - the server's real /preview endpoint uses multer
 * (upload.array('files', 10)), not a JSON body (confirmed by reading
 * keys.ts directly). This is the route the vendored dashboard's own
 * import flow actually uses (preview -> importSelected below); the
 * separate one-shot POST /import endpoint is legacy and was never
 * reachable from their own UI, so it's intentionally not wrapped here.
 */
export async function previewImport(
  conn: FreellmapiKeysConn,
  files: Array<{ filename: string; content: Buffer }>
): Promise<ImportPreviewResult> {
  const form = new FormData();
  for (const file of files) {
    // Buffer's ArrayBufferLike backing (possibly a SharedArrayBuffer) isn't
    // directly assignable to BlobPart under this project's strict TS config -
    // Uint8Array.from() copies into a plain ArrayBuffer-backed view instead.
    form.append("files", new Blob([Uint8Array.from(file.content)]), file.filename);
  }
  const res = await fetch(`http://127.0.0.1:${conn.port}/api/keys/preview`, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error?.message ?? `Request failed: ${res.status} ${res.statusText}`);
  }
  return data as ImportPreviewResult;
}

export interface ImportKeyEntry {
  keyName?: string;
  keyValue: string;
  platform: string;
  baseUrl?: string;
  models?: Array<{ id: string; supportsTools?: boolean; supportsVision?: boolean }>;
}
export interface ImportSelectedResult {
  imported: number;
  skipped: string[];
  errors: Array<{ key: string; error: string }>;
  total: number;
  modelsRegistered: number;
}
export async function importSelected(conn: FreellmapiKeysConn, keys: ImportKeyEntry[]): Promise<ImportSelectedResult> {
  return request(conn, "POST", "/import-selected", { keys });
}

/**
 * Returns the real response BODY AS TEXT, unmodified - never parsed and
 * re-shaped. Confirmed by reading the real /export handler directly: the
 * json format sends {version, exportedAt, source, keys:[...]} via
 * res.json() (not a bare array), while env/csv formats send plain text via
 * res.send() (not JSON at all - calling res.json() on that response would
 * silently resolve to {} instead of throwing). The server already formats
 * every type correctly (including edge cases like duplicate key names and
 * custom-endpoint base URLs - see its own inline comments), so the only
 * correct client behavior is to write its output back out unchanged, not
 * re-implement formatting this file has no reason to get right twice.
 */
export async function exportKeys(conn: FreellmapiKeysConn, format: "json" | "env" = "json"): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${conn.port}/api/keys/export?format=${format}`, {
    headers: { Authorization: `Bearer ${conn.token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    let message = `Request failed: ${res.status} ${res.statusText}`;
    try {
      message = JSON.parse(text)?.error?.message ?? message;
    } catch {
      // The error body wasn't JSON either - keep the generic message.
    }
    throw new Error(message);
  }
  return text;
}

export async function updatePlatformSettings(
  conn: FreellmapiKeysConn,
  platform: string,
  params: { enabled?: boolean }
): Promise<{ success: true }> {
  return request(conn, "PATCH", `/platform/${platform}`, params);
}

export interface AddCustomProviderParams {
  baseUrl?: string;
  keyId?: number;
  model?: string;
  models?: string[];
  displayName?: string;
  apiKey?: string;
  label?: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
}
export async function addCustomProvider(conn: FreellmapiKeysConn, params: AddCustomProviderParams): Promise<{ success: true; keyId: number }> {
  return request(conn, "POST", "/custom", params);
}

export interface DiscoverModelsParams {
  baseUrl?: string;
  keyId?: number;
  apiKey?: string;
}
export interface DiscoveredModel {
  id: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
}
export async function discoverModels(conn: FreellmapiKeysConn, params: DiscoverModelsParams): Promise<{ models: DiscoveredModel[] }> {
  return request(conn, "POST", "/custom/discover-models", params);
}

export async function probeCustomProvider(conn: FreellmapiKeysConn, params: DiscoverModelsParams): Promise<{ ok: boolean }> {
  return request(conn, "POST", "/custom/probe", params);
}
