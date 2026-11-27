import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ClientName = "cursor" | "claude" | "antigravity";

export interface ClientTarget {
  name: ClientName;
  label: string;
  configPath: string;
}

export interface SetupResult {
  client: ClientName;
  label: string;
  configPath: string;
  status: "updated" | "created" | "skipped" | "removed";
  reason?: string;
}

export function getClientTargets(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): ClientTarget[] {
  const cursorPath = path.join(homeDir, ".cursor", "mcp.json");

  let claudePath: string;
  if (platform === "darwin") {
    claudePath = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json"
    );
  } else if (platform === "win32") {
    const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    claudePath = path.join(appData, "Claude", "claude_desktop_config.json");
  } else {
    claudePath = path.join(homeDir, ".config", "Claude", "claude_desktop_config.json");
  }

  const antigravityPath = path.join(homeDir, ".gemini", "antigravity", "mcp_config.json");

  return [
    { name: "cursor", label: "Cursor", configPath: cursorPath },
    { name: "claude", label: "Claude Desktop", configPath: claudePath },
    { name: "antigravity", label: "Antigravity", configPath: antigravityPath },
  ];
}

export function buildServerEntry(serverEntryPath: string): {
  command: string;
  args: string[];
} {
  return {
    command: "node",
    args: [path.resolve(serverEntryPath)],
  };
}

async function readJsonSafe(filePath: string): Promise<{
  exists: boolean;
  data: Record<string, unknown>;
  parseError?: string;
}> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const trimmed = raw.trim();
    if (!trimmed) return { exists: true, data: {} };
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return { exists: true, data: parsed };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false, data: {} };
    }
    return {
      exists: true,
      data: {},
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function installMcpConfigs(options: {
  serverEntryPath: string;
  serverKey?: string;
  targets?: ClientTarget[];
  createMissingDirs?: boolean;
}): Promise<SetupResult[]> {
  const serverKey = options.serverKey ?? "blast-radius";
  const targets = options.targets ?? getClientTargets();
  const createMissingDirs = options.createMissingDirs ?? true;
  const entry = buildServerEntry(options.serverEntryPath);
  const results: SetupResult[] = [];

  for (const target of targets) {
    const parentDir = path.dirname(target.configPath);
    let parentExists = true;
    try {
      await fs.access(parentDir);
    } catch {
      parentExists = false;
    }

    if (!parentExists && !createMissingDirs) {
      results.push({
        client: target.name,
        label: target.label,
        configPath: target.configPath,
        status: "skipped",
        reason: "Client directory not found",
      });
      continue;
    }

    const { exists, data, parseError } = await readJsonSafe(target.configPath);
    if (parseError) {
      results.push({
        client: target.name,
        label: target.label,
        configPath: target.configPath,
        status: "skipped",
        reason: `Invalid JSON: ${parseError}`,
      });
      continue;
    }

    const mcpServers =
      typeof data.mcpServers === "object" && data.mcpServers !== null
        ? (data.mcpServers as Record<string, unknown>)
        : {};

    mcpServers[serverKey] = entry;
    data.mcpServers = mcpServers;

    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(
      target.configPath,
      JSON.stringify(data, null, 2) + "\n",
      "utf8"
    );

    results.push({
      client: target.name,
      label: target.label,
      configPath: target.configPath,
      status: exists ? "updated" : "created",
    });
  }

  return results;
}

export async function uninstallMcpConfigs(options?: {
  serverKey?: string;
  targets?: ClientTarget[];
}): Promise<SetupResult[]> {
  const serverKey = options?.serverKey ?? "blast-radius";
  const targets = options?.targets ?? getClientTargets();
  const results: SetupResult[] = [];

  for (const target of targets) {
    const { exists, data, parseError } = await readJsonSafe(target.configPath);
    if (!exists || parseError) {
      results.push({
        client: target.name,
        label: target.label,
        configPath: target.configPath,
        status: "skipped",
        reason: parseError ? `Invalid JSON: ${parseError}` : "Config not found",
      });
      continue;
    }

    const mcpServers = data.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || !(serverKey in mcpServers)) {
      results.push({
        client: target.name,
        label: target.label,
        configPath: target.configPath,
        status: "skipped",
        reason: "Entry not present",
      });
      continue;
    }

    delete mcpServers[serverKey];
    await fs.writeFile(
      target.configPath,
      JSON.stringify(data, null, 2) + "\n",
      "utf8"
    );

    results.push({
      client: target.name,
      label: target.label,
      configPath: target.configPath,
      status: "removed",
    });
  }

  return results;
}
