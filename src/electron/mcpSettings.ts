import fs from "node:fs/promises";
import type { StorageCrypto } from "./googleAuth.js";

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

export async function loadMcpSettings(settingsFilePath: string, storageCrypto?: StorageCrypto): Promise<McpServerConfig[]> {
  try {
    const raw = await fs.readFile(settingsFilePath, "utf-8");
    const json = storageCrypto ? storageCrypto.decrypt(raw) : raw;
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidConfig);
  } catch {
    return [];
  }
}

export async function saveMcpSettings(settingsFilePath: string, servers: McpServerConfig[], storageCrypto?: StorageCrypto): Promise<void> {
  const json = JSON.stringify(servers, null, 2);
  const toWrite = storageCrypto ? storageCrypto.encrypt(json) : json;
  await fs.writeFile(settingsFilePath, toWrite, { encoding: "utf-8", mode: 0o600 });
}
