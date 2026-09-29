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
