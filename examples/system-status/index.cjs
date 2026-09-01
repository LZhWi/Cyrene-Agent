"use strict";

const os = require("node:os");
const { execFile } = require("node:child_process");

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
      id: "system_status",
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
      id: "disk_usage",
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

    ctx.log("系统状态插件已注册: system_status / disk_usage");
  },
};

module.exports = systemStatusPlugin;
module.exports.default = systemStatusPlugin;
