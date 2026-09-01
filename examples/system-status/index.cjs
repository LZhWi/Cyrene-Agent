"use strict";

const os = require("node:os");
const { execFile } = require("node:child_process");

/** 插件自己的状态窗口实例；open() 时创建，unregister() 时关闭 */
let pluginWin = null;

/** @returns {Promise<{ok: boolean, stdout?: string, stderr?: string}>} */
function runCommand(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function readWindowsBattery() {
  const r = await runCommand("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json -Compress",
  ]);
  if (!r.ok || !r.stdout.trim()) return null;
  try {
    const raw = JSON.parse(r.stdout);
    if (raw == null) return null;
    // BatteryStatus: 1=放电 2=充电(接交流) 其余视为异常
    const charging = raw.BatteryStatus === 2;
    return { percent: Number(raw.EstimatedChargeRemaining), charging };
  } catch {
    return null;
  }
}

async function collectStatus() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const load = os.loadavg()[0];

  const lines = [];
  lines.push(`系统: ${os.type()} ${os.release()} (${os.arch()})`);
  lines.push(`主机名: ${os.hostname()}`);
  lines.push(`CPU: ${cpus[0] ? cpus[0].model.trim() : "未知"} · ${cpus.length} 核心`);
  lines.push(`内存: ${formatBytes(usedMem)} / ${formatBytes(totalMem)}（使用率 ${((usedMem / totalMem) * 100).toFixed(1)}%）`);
  lines.push(`已运行: ${formatUptime(os.uptime())}`);
  if (load > 0) lines.push(`平均负载(1min): ${load.toFixed(2)}`);

  const battery = await readWindowsBattery();
  if (battery) {
    lines.push(`电池: ${battery.percent}%（${battery.charging ? "充电中" : "使用电池"}）`);
  } else {
    lines.push("电池: 未检测到（台式机或未上报）");
  }
  return lines;
}

function formatBytes(bytes) {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 24) {
    const d = Math.floor(h / 24);
    return `${d} 天 ${h % 24} 小时`;
  }
  return `${h} 小时 ${m} 分钟`;
}

async function diskUsage(drive) {
  const letter = drive ? drive.toUpperCase() : "C";
  const r = await runCommand("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `$d = Get-PSDrive -Name "${letter}" -ErrorAction SilentlyContinue; if ($d) { "$($d.Used) $($d.Free)" } else { Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Size - $_.FreeSpace) $($_.FreeSpace)" } }`,
  ]);
  if (!r.ok || !r.stdout.trim()) return null;
  const [usedStr, freeStr] = r.stdout.trim().split(/\s+/);
  const used = Number(usedStr);
  const free = Number(freeStr);
  if (!Number.isFinite(used) || !Number.isFinite(free) || used + free <= 0) return null;
  return { drive: letter, used, free, total: used + free };
}

async function collectDisk(drive) {
  const d = await diskUsage(drive);
  if (!d) return `磁盘 ${drive ? drive.toUpperCase() : "系统"}: 无法读取`;
  const pct = ((d.used / d.total) * 100).toFixed(1);
  return `磁盘 ${d.drive}: 已用 ${formatBytes(d.used)} / ${formatBytes(d.total)}（${pct}%），剩余 ${formatBytes(d.free)}`;
}

const systemStatusPlugin = {
  register(ctx) {
    ctx.registerTool({
      id: "system-status_status",
      name: "系统状态查询",
      description: "查询本机系统状态，包括操作系统、CPU、内存、电池与开机时长。用户问电脑还剩多少电、内存占用、开了多久等问题时使用。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      async execute() {
        const lines = await collectStatus();
        return lines.join("\n");
      },
    });

    ctx.registerTool({
      id: "system-status_disk",
      name: "磁盘占用查询",
      description: "查询磁盘空间占用情况。可选指定盘符（如 C、D、E），不指定则查询系统盘。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          drive: { type: "string", description: "Windows 盘符字母，例如 C、D、E；留空查询系统所在盘" },
        },
        required: [],
      },
      async execute(args) {
        const drive = typeof args.drive === "string" && /^[a-z]$/i.test(args.drive.trim()) ? args.drive.trim().toUpperCase() : undefined;
        return collectDisk(drive);
      },
    });

    ctx.registerIpc("snapshot", async () => {
      const lines = await collectStatus();
      const osMod = require("node:os");
      const totalMem = osMod.totalmem();
      const usedMem = totalMem - osMod.freemem();
      const disk = await diskUsage("C");
      return {
        memory: `${formatBytes(usedMem)} / ${formatBytes(totalMem)}`,
        memoryPercent: Math.round((usedMem / totalMem) * 100),
        disk: disk ? `已用 ${formatBytes(disk.used)} / ${formatBytes(disk.total)}` : "无法读取",
        diskPercent: disk ? Math.round((disk.used / disk.total) * 100) : 0,
        cpu: `${osMod.cpus()[0] ? osMod.cpus()[0].model.trim() : "未知"} · ${osMod.cpus().length} 核`,
        uptime: formatUptime(osMod.uptime()),
      };
    });

    ctx.log("系统状态插件已注册: system-status_status / system-status_disk");
  },

  async open() {
    if (pluginWin && !pluginWin.isDestroyed()) {
      pluginWin.focus();
      return;
    }
    const { BrowserWindow } = require("electron");
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>系统状态</title>
<style>
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #1e1e2e; color: #cdd6f4;
         margin: 0; padding: 24px; user-select: none; }
  h1 { font-size: 16px; margin: 0 0 16px; color: #f5c2e7; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .card { background: #313244; border-radius: 12px; padding: 14px 16px; }
  .card .label { font-size: 12px; opacity: 0.7; margin-bottom: 6px; }
  .card .value { font-size: 18px; font-weight: 600; }
  .bar { height: 8px; border-radius: 4px; background: #45475a; margin-top: 8px; overflow: hidden; }
  .bar .fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #f5c2e7, #cba6f7); }
  #hint { margin-top: 16px; font-size: 12px; opacity: 0.5; }
</style>
</head>
<body>
  <h1>本机系统状态</h1>
  <div class="grid">
    <div class="card"><div class="label">内存</div><div class="value" id="mem">读取中…</div><div class="bar"><div class="fill" id="memBar"></div></div></div>
    <div class="card"><div class="label">系统盘</div><div class="value" id="disk">读取中…</div><div class="bar"><div class="fill" id="diskBar"></div></div></div>
    <div class="card"><div class="label">CPU</div><div class="value" id="cpu">读取中…</div></div>
    <div class="card"><div class="label">已运行</div><div class="value" id="uptime">读取中…</div></div>
  </div>
  <div id="hint">数据每 3 秒刷新一次 · 来自系统状态插件</div>
<script>
  const { ipcRenderer } = require("electron");
  async function refresh() {
    try {
      const s = await ipcRenderer.invoke("plugin:system-status:snapshot");
      mem.textContent = s.memory;
      memBar.style.width = s.memoryPercent + "%";
      disk.textContent = s.disk;
      diskBar.style.width = s.diskPercent + "%";
      cpu.textContent = s.cpu;
      uptime.textContent = s.uptime;
    } catch (e) { /* 忽略单次失败 */ }
  }
  refresh();
  setInterval(refresh, 3000);
</script>
</body>
</html>`;
    pluginWin = new BrowserWindow({
      width: 480,
      height: 360,
      title: "系统状态",
      resizable: true,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    pluginWin.on("closed", () => { pluginWin = null; });
    await pluginWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  },

  unregister() {
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
  },
};

module.exports = systemStatusPlugin;
module.exports.default = systemStatusPlugin;
