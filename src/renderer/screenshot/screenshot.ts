/**
 * 截图覆盖窗渲染逻辑。
 *
 * 流程：
 *   1. 页面加载 -> screenshotOverlay.ready()
 *   2. 主进程发送截图数据 -> onData()
 *   3. 解码图片 -> 画到 canvas -> screenshotOverlay.rendered()
 *   4. 主进程 show() 窗口
 *   5. 用户拖框选区 / 双击全屏 / Esc 取消
 *   6. screenshotOverlay.select(sessionId, x, y, w, h) 或 cancel()
 */

interface ScreenshotData {
  base64: string;
  imageWidth: number;
  imageHeight: number;
  displayWidth: number;
  displayHeight: number;
  sessionId: string;
}

interface ScreenshotOverlayApi {
  ready: () => void;
  onData: (cb: (data: ScreenshotData) => void) => () => void;
  rendered: () => void;
  select: (sessionId: string, x: number, y: number, w: number, h: number) => void;
  cancel: () => void;
}

declare global {
  interface Window {
    screenshotOverlay: ScreenshotOverlayApi;
  }
}

const MIN_SELECTION_SIZE = 4;

const canvas = document.getElementById("screenshot-canvas") as HTMLCanvasElement;
const hintEl = document.getElementById("screenshot-hint") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;

let screenshotImage: HTMLImageElement | null = null;
let sessionId = "";
let displayW = 0;
let displayH = 0;

// 选区状态
let isSelecting = false;
let startX = 0;
let startY = 0;
let curX = 0;
let curY = 0;

/** 全屏重绘：截图 + 暗色遮罩 + 选区透亮 + 边框 + 尺寸标注 */
function redraw(): void {
  if (!screenshotImage) return;

  // 1. 画截图
  ctx.drawImage(screenshotImage, 0, 0, canvas.width, canvas.height);

  if (!isSelecting && curX === 0 && curY === 0) return; // 没有选区，只画截图+暗色

  // 2. 画暗色遮罩
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (isSelecting || (curX !== startX || curY !== startY)) {
    // 3. 选区内擦除遮罩，显示原图
    const sx = Math.min(startX, curX);
    const sy = Math.min(startY, curY);
    const sw = Math.abs(curX - startX);
    const sh = Math.abs(curY - startY);

    if (sw > 0 && sh > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, sy, sw, sh);
      ctx.clip();
      ctx.drawImage(screenshotImage, 0, 0, canvas.width, canvas.height);
      ctx.restore();

      // 4. 选区边框
      ctx.strokeStyle = "#ec4899";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, sy, sw, sh);

      // 5. 尺寸标注
      const label = `${Math.round(sw)} × ${Math.round(sh)}`;
      ctx.font = "13px system-ui, -apple-system, sans-serif";
      const metrics = ctx.measureText(label);
      const labelW = metrics.width + 16;
      const labelH = 22;
      const labelX = sx + sw + 6;
      const labelY = sy + sh + 6;
      // 防止标注超出右下边界
      const finalLabelX = labelX + labelW > canvas.width ? sx + sw - labelW - 12 : labelX;
      const finalLabelY = labelY + labelH > canvas.height ? sy + sh - labelH - 12 : labelY;

      ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
      ctx.fillRect(finalLabelX, finalLabelY, labelW, labelH);
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(label, finalLabelX + 8, finalLabelY + labelH / 2 + 1);
    }
  }
}

function onMouseDown(e: MouseEvent): void {
  isSelecting = true;
  startX = e.clientX;
  startY = e.clientY;
  curX = e.clientX;
  curY = e.clientY;
  hintEl.classList.add("is-hidden");
}

function onMouseMove(e: MouseEvent): void {
  if (!isSelecting) return;
  curX = e.clientX;
  curY = e.clientY;
  redraw();
}

function onMouseUp(e: MouseEvent): void {
  if (!isSelecting) return;
  isSelecting = false;
  curX = e.clientX;
  curY = e.clientY;

  const w = Math.abs(curX - startX);
  const h = Math.abs(curY - startY);

  // 选区太小视为单击，不提交（让 dblclick 有机会触发）
  if (w < MIN_SELECTION_SIZE || h < MIN_SELECTION_SIZE) {
    redraw();
    return;
  }

  const x = Math.min(startX, curX);
  const y = Math.min(startY, curY);
  window.screenshotOverlay.select(sessionId, x, y, w, h);
}

function onDblClick(): void {
  // 双击 = 全屏选取
  window.screenshotOverlay.select(sessionId, 0, 0, displayW, displayH);
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    window.screenshotOverlay.cancel();
  }
}

// ── 初始化 ──────────────────────────────────────────────

function init(): void {
  // 设置 canvas 尺寸为窗口 CSS 尺寸
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  displayW = window.innerWidth;
  displayH = window.innerHeight;

  window.addEventListener("resize", () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    displayW = window.innerWidth;
    displayH = window.innerHeight;
    redraw();
  });

  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("dblclick", onDblClick);
  document.addEventListener("keydown", onKeyDown);

  // 通知主进程窗口已就绪
  window.screenshotOverlay.ready();

  // 接收截图数据
  window.screenshotOverlay.onData((data) => {
    sessionId = data.sessionId;
    displayW = data.displayWidth;
    displayH = data.displayHeight;

    // 确保 canvas 尺寸与 display 一致
    canvas.width = data.displayWidth;
    canvas.height = data.displayHeight;

    const img = new Image();
    img.onload = () => {
      screenshotImage = img;
      redraw();

      // 用 requestAnimationFrame 确保画完后才通知
      requestAnimationFrame(() => {
        window.screenshotOverlay.rendered();
      });
    };
    img.onerror = () => {
      // 解码失败也要通知，否则主进程会一直等
      window.screenshotOverlay.cancel();
    };
    img.src = `data:image/png;base64,${data.base64}`;
  });
}

init();
