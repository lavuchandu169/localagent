import type { StorageCrypto } from "./googleAuth.js";
import { loadEncryptedJson, saveEncryptedJson } from "./encryptedJsonFile.js";

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

function isValidConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<McpServerConfig>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.command === "string" &&
    Array.isArray(v.args) &&
    v.args.every((a) => typeof a === "string") &&
    typeof v.env === "object" &&
    v.env !== null &&
    Object.values(v.env).every((e) => typeof e === "string") &&
    typeof v.enabled === "boolean"
  );
}

function parseMcpSettings(parsed: unknown): McpServerConfig[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidConfig);
}

export async function loadMcpSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<McpServerConfig[]> {
  return loadEncryptedJson(settingsFilePath, storageCrypto, parseMcpSettings, []);
}

export async function saveMcpSettings(settingsFilePath: string, servers: McpServerConfig[], storageCrypto?: StorageCrypto): Promise<void> {
  await saveEncryptedJson(settingsFilePath, servers, storageCrypto);
}
