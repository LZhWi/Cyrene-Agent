// Token 用量面板：指标卡片 + 柱状图 + Chart.js 波浪图
// 从 settings.ts 抽离。依赖 chart.js + tokensState。
// 副作用导入：模块加载时执行事件绑定 + 初始渲染。

import { Chart, registerables, type ChartConfiguration } from "chart.js";
import { tokensState } from "./state";

Chart.register(...registerables);

interface TokenDayData {
  date: string;       // ISO 日期 "06-15"
  weekday: string;    // "周日"
  input: number;
  output: number;
  hit: number;        // 缓存命中（占位 0）
  miss: number;       // 缓存未命中（占位 0）
  requests: number;
}

declare global {
  interface Window {
    tokenUsage?: {
      get: (days: number) => Promise<TokenDayData[]>;
    };
  }
}

// 柱状图：根据数据动态生成柱子（复用 chart.css 的 .chart-bar 样式）
function renderTokenBarChart(data: TokenDayData[]): void {
  const container = document.getElementById("token-bar-chart");
  if (!container) return;
  container.innerHTML = "";

  const maxVal = Math.max(...data.map((d) => d.input + d.output), 1);
  const peakIdx = data.reduce((peak, d, i, arr) =>
    (d.input + d.output) > (arr[peak].input + arr[peak].output) ? i : peak, 0);

  // 柱状图最多显示 14 根（30d 时隔天显示），避免太挤
  const displayData = data.length > 14
    ? data.filter((_, i) => i % 2 === 0)
    : data;

  // 容器实际可用高度（mini-chart 高度 112px - padding-top 18px - 底部 label 区 18px ≈ 76px）
  // 用固定像素高度，避免 flex 百分比高度在 padding 容器里不可靠
  const chartHeight = 76;

  for (let i = 0; i < displayData.length; i++) {
    const d = displayData[i];
    const total = d.input + d.output;
    const barH = Math.max(6, Math.round((total / maxVal) * chartHeight));
    const bar = document.createElement("div");
    bar.className = "token-bar";
    // 峰值柱加标记
    const origIdx = data.indexOf(d);
    if (origIdx === peakIdx) bar.classList.add("token-bar--peak");

    // 真实 fill div（不用伪元素，直接控制像素高度）
    const fill = document.createElement("div");
    fill.className = "token-bar__fill";
    fill.style.height = barH + "px";

    const label = document.createElement("span");
    label.className = "token-bar__label";
    label.textContent = d.date.split("-")[1]; // 只显示日
    bar.appendChild(fill);
    bar.appendChild(label);

    // hover tooltip
    bar.addEventListener("mouseenter", (e) => showTokenTooltip(e, d));
    bar.addEventListener("mousemove", (e) => moveTokenTooltip(e));
    bar.addEventListener("mouseleave", hideTokenTooltip);

    container.appendChild(bar);
  }

  // 日均标签
  const avgEl = document.getElementById("token-avg-label");
  if (avgEl) {
    const avg = Math.round(data.reduce((s, d) => s + d.input + d.output, 0) / data.length);
    avgEl.textContent = `日均 ${formatTokenShort(avg)}`;
  }
}

function formatTokenShort(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

// tooltip 显示/移动/隐藏
function showTokenTooltip(e: MouseEvent, d: TokenDayData): void {
  const tip = document.getElementById("token-tooltip");
  if (!tip) return;
  tip.innerHTML = `
    <div class="token-tooltip__date">${d.date} ${d.weekday}</div>
    <div class="token-tooltip__row"><span>📥 输入</span><span>${d.input.toLocaleString()}</span></div>
    <div class="token-tooltip__row"><span>📤 输出</span><span>${d.output.toLocaleString()}</span></div>
    <div class="token-tooltip__row"><span>🎯 命中</span><span>${d.hit > 0 ? d.hit.toLocaleString() : "N/A"}</span></div>
    <div class="token-tooltip__row"><span>❌ 未命中</span><span>${d.miss > 0 ? d.miss.toLocaleString() : "N/A"}</span></div>
  `;
  tip.hidden = false;
  moveTokenTooltip(e);
}

function moveTokenTooltip(e: MouseEvent): void {
  const tip = document.getElementById("token-tooltip");
  if (!tip || tip.hidden) return;
  const offset = 14;
  let x = e.clientX + offset;
  let y = e.clientY + offset;
  // 防止超出视口右边
  const tipW = tip.offsetWidth;
  if (x + tipW > window.innerWidth) x = e.clientX - tipW - offset;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}

function hideTokenTooltip(): void {
  const tip = document.getElementById("token-tooltip");
  if (tip) tip.hidden = true;
}

// Chart.js 波浪面积图

function renderTokenTrendChart(data: TokenDayData[]): void {
  const canvas = document.getElementById("token-trend-chart") as HTMLCanvasElement | null;
  if (!canvas) return;

  // 销毁旧实例避免重叠
  if (tokensState.trendChart) { tokensState.trendChart.destroy(); tokensState.trendChart = null; }

  const labels = data.map((d) => d.date);
  const inputData = data.map((d) => d.input);
  const outputData = data.map((d) => d.output);

  const config: ChartConfiguration = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "📥 输入",
          data: inputData,
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59, 130, 246, 0.15)",
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: "#3b82f6",
        },
        {
          label: "📤 输出",
          data: outputData,
          borderColor: "#ff8ccc",
          backgroundColor: "rgba(255, 140, 204, 0.15)",
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: "#ff8ccc",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: { color: "rgba(235, 229, 245, 0.7)", font: { size: 11 }, boxWidth: 12, boxHeight: 12 },
        },
        tooltip: {
          // 用 Chart.js 自带 tooltip，显示输入/输出/命中/未命中
          backgroundColor: "rgba(30, 20, 45, 0.95)",
          borderColor: "rgba(255, 182, 220, 0.3)",
          borderWidth: 1,
          titleColor: "rgba(254, 247, 255, 0.95)",
          bodyColor: "rgba(235, 229, 245, 0.85)",
          padding: 10,
          cornerRadius: 10,
          displayColors: true,
          callbacks: {
            title: (items) => {
              const idx = items[0].dataIndex;
              const d = data[idx];
              return `${d.date} ${d.weekday}`;
            },
            label: (item) => {
              const idx = item.dataIndex;
              const d = data[idx];
              const which = item.datasetIndex === 0 ? "input" : "output";
              const val = which === "input" ? d.input : d.output;
              return `${which === "input" ? "📥 输入" : "📤 输出"}: ${val.toLocaleString()}`;
            },
            afterBody: (items) => {
              const idx = items[0].dataIndex;
              const d = data[idx];
              return [
                `🎯 命中: ${d.hit > 0 ? d.hit.toLocaleString() : "N/A"}`,
                `❌ 未命中: ${d.miss > 0 ? d.miss.toLocaleString() : "N/A"}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: "rgba(235, 229, 245, 0.45)", font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
        },
        y: {
          grid: { color: "rgba(255, 182, 220, 0.08)" },
          ticks: {
            color: "rgba(235, 229, 245, 0.45)",
            font: { size: 10 },
            callback: (v) => formatTokenShort(Number(v)),
          },
          beginAtZero: true,
        },
      },
    },
  };

  tokensState.trendChart = new Chart(canvas, config);
}

// 更新指标卡片
function updateTokenStats(data: TokenDayData[]): void {
  const totalInput = data.reduce((s, d) => s + d.input, 0);
  const totalOutput = data.reduce((s, d) => s + d.output, 0);
  const total = totalInput + totalOutput;
  const requests = data.reduce((s, d) => s + d.requests, 0);

  const set = (id: string, val: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  set("token-total", total.toLocaleString());
  set("token-requests", requests.toLocaleString());
  set("token-input", totalInput.toLocaleString());
  set("token-output", totalOutput.toLocaleString());
  set("token-hit", "N/A");
}

// 刷新整个面板：调 IPC 拉真实数据 → 有数据渲染图表，无数据显示空态
async function refreshTokenPanel(days: number): Promise<void> {
  let data: TokenDayData[] = [];
  try {
    data = await window.tokenUsage?.get(days) ?? [];
  } catch (err) {
    console.warn("[settings] 拉取 Token 用量失败:", err);
  }

  const hasData = data.some((d) => d.input > 0 || d.output > 0 || d.requests > 0);
  const emptyEl = document.getElementById("token-empty");
  const chartsEl = document.getElementById("token-charts");

  if (!hasData) {
    // 空态：隐藏图表区，显示空态提示，指标卡片归零
    if (emptyEl) emptyEl.classList.remove("is-hidden");
    if (chartsEl) chartsEl.classList.add("is-hidden");
    const set = (id: string, val: string) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set("token-total", "0");
    set("token-requests", "0");
    set("token-input", "0");
    set("token-output", "0");
    set("token-hit", "N/A");
    return;
  }

  // 有数据：显示图表区，隐藏空态
  if (emptyEl) emptyEl.classList.add("is-hidden");
  if (chartsEl) chartsEl.classList.remove("is-hidden");
  updateTokenStats(data);
  renderTokenBarChart(data);
  renderTokenTrendChart(data);
}

// 时间范围按钮交互
document.querySelectorAll<HTMLButtonElement>(".token-range__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".token-range__btn").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-selected", "true");
    const days = Number(btn.dataset.range) || 7;
    void refreshTokenPanel(days);
  });
});

// 初始渲染
void refreshTokenPanel(7);
