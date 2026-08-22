const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-mcp-real-"));
const configPath = process.env.CYRENE_MCP_CONFIG_PATH
  || path.join(process.env.APPDATA || "", "live2d-cyrene", "mcp-servers.json");
const fixedVersion = process.env.CYRENE_MCP_FIXED_VERSION || "";
app.setPath("userData", profileDir);

function loadIsolatedConfigs() {
  const configs = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!Array.isArray(configs)) throw new Error("mcp-servers.json is not an array");
  return configs.map((config) => {
    const copy = { ...config, env: config.env ? { ...config.env } : undefined };
    if (fixedVersion && copy.id === "playwright-mcp" && Array.isArray(copy.args)) {
      copy.args = [
        "--offline",
        ...copy.args.map((arg) => arg === "@playwright/mcp@latest" ? `@playwright/mcp@${fixedVersion}` : arg),
      ];
    }
    return copy;
  });
}

app.whenReady().then(async () => {
  const { connectMcpServer, disconnectMcpServer, getMcpServerStates } = require("../dist/main/main/orchestrator/mcp-adapter.js");
  const configs = loadIsolatedConfigs();
  const connected = [];
  try {
    for (const config of configs) {
      const toolIds = await connectMcpServer(config);
      connected.push({ id: config.id, toolCount: toolIds.length });
    }
  } finally {
    await Promise.allSettled(connected.map(({ id }) => disconnectMcpServer(id)));
  }
  const remaining = getMcpServerStates();
  if (remaining.length !== 0) throw new Error(`MCP state leaked after disconnect: ${JSON.stringify(remaining)}`);
  console.log(`CYRENE_MCP_SMOKE_RESULT=${JSON.stringify({ ok: true, connected, profileIsolated: true, remaining: 0 })}`);
}).catch((error) => {
  console.error(`CYRENE_MCP_SMOKE_ERROR=${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
  app.quit();
});
