/**
 * 截图覆盖窗 v2 -- 常驻 MediaStream + 即时冻结选区 + 微信式确认。
 *
 * 性能关键路径（每段都打点）：
 *   hotkeyReceived -> frameRequested -> frameAvailable -> canvasPainted
 *                    -> overlayShown -> selectionConfirmed -> pngEncoded
 *                    -> clipboardWritten
 */

interface StartSessionData {
  sessionId: string;
  fromButton: boolean;
  displayWidth: number;
  displayHeight: number;
  timings: Record<string, number>;
}

interface ScreenshotOverlayApi {
  onStartSession: (cb: (data: StartSessionData) => void) => () => void;
  frameReady: (sessionId: string, timings: Record<string, number>) => void;
  onShown: (cb: (data: { timings: Record<string, number> }) => void) => () => void;
  confirm: (payload: {
    sessionId: string;
    png: ArrayBuffer;
    width: number;
    height: number;
    timings: Record<string, number>;
  }) => void;
  cancel: (sessionId: string, reason: string) => void;
  ready: () => void;
}

declare global {
  interface Window {
    screenshotOverlay: ScreenshotOverlayApi;
  }
}

const canvas = document.getElementById("screenshot-canvas") as HTMLCanvasElement;
const video = document.getElementById("screenshot-video") as HTMLVideoElement;
const dimmer = document.getElementById("screenshot-dimmer") as HTMLCanvasElement;
const toolbar = document.getElementById("screenshot-toolbar") as HTMLDivElement;
const toolbarConfirm = document.getElementById("screenshot-confirm") as HTMLButtonElement;
const toolbarCancel = document.getElementById("screenshot-cancel") as HTMLButtonElement;
const hintEl = document.getElementById("screenshot-hint") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;
const dimCtx = dimmer.getContext("2d")!;

const MIN_SELECTION_SIZE = 4;

// ── 状态机 ────────────────────────────────────────────────

type State = "idle" | "selecting" | "selected" | "submitting";
let state: State = "idle";
let sessionId = "";
let sessionFromButton = false;
let capturedFrameWidth = 0;
let capturedFrameHeight = 0;
let displayW = 0;
let displayH = 0;
let timings: Record<string, number> = {};

let stream: MediaStream | null = null;
let streamReady = false;
let activePointerId: number | null = null;

let selection = { x: 0, y: 0, w: 0, h: 0 }; // CSS 像素
let startPos = { x: 0, y: 0 };

// ── 屏幕流管理 ────────────────────────────────────────────

async function initStream(): Promise<void> {
  if (streamReady || stream) return;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        // @ts-ignore -- Electron 支持 frameRate
        frameRate: 30,
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      } as MediaTrackConstraints,
      audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => undefined);

    // 任一 track 结束则失效
    const tracks = stream.getVideoTracks();
    if (tracks.length > 0) {
      tracks[0].addEventListener("ended", () => {
        streamReady = false;
        stream = null;
        console.warn("[Screenshot] 屏幕流已结束，将需要重新初始化");
      });
    }
    streamReady = true;
  } catch (err) {
    console.error("[Screenshot] 屏幕流初始化失败:", err);
    streamReady = false;
    stream = null;
  }
}

/** 把视频当前帧画到 canvas */
async function captureFrameToCanvas(): Promise<void> {
  if (!streamReady || !video.videoWidth || !video.videoHeight) {
    throw new Error("STREAM_NOT_READY");
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // dimmer 与 canvas 同步
  dimmer.width = canvas.width;
  dimmer.height = canvas.height;
  redrawDimmer();
}

/** 重绘暗色遮罩 + 选区 */
function redrawDimmer(): void {
  // 暗色铺满
  dimCtx.fillStyle = "rgba(0, 0, 0, 0.45)";
  dimCtx.fillRect(0, 0, dimmer.width, dimmer.height);

  if (state === "idle" || selection.w < MIN_SELECTION_SIZE || selection.h < MIN_SELECTION_SIZE) {
    return;
  }

  // 选区抠图：重画选区部分覆盖暗色
  const sx = selection.x;
  const sy = selection.y;
  const sw = selection.w;
  const sh = selection.h;
  const rect = canvas.getBoundingClientRect();
  const ratioX = canvas.width / rect.width;
  const ratioY = canvas.height / rect.height;

  dimCtx.save();
  dimCtx.beginPath();
  dimCtx.rect(sx, sy, sw, sh);
  dimCtx.clip();
  dimCtx.drawImage(canvas, 0, 0);
  dimCtx.restore();

  // 边框
  dimCtx.strokeStyle = "#ec4899";
  dimCtx.lineWidth = 2;
  dimCtx.strokeRect(sx, sy, sw, sh);

  // 尺寸标注
  const label = `${Math.round(sw)} × ${Math.round(sh)}`;
  dimCtx.font = "13px system-ui, -apple-system, sans-serif";
  const metrics = dimCtx.measureText(label);
  const labelW = metrics.width + 16;
  const labelH = 22;
  let labelX = sx + sw + 6;
  let labelY = sy + sh + 6;
  // 防止出界
  if (labelX + labelW > dimmer.width) labelX = sx - labelW - 6;
  if (labelY + labelH > dimmer.height) labelY = sy - labelH - 6;

  dimCtx.fillStyle = "rgba(0, 0, 0, 0.75)";
  dimCtx.fillRect(labelX, labelY, labelW, labelH);
  dimCtx.fillStyle = "#fff";
  dimCtx.textBaseline = "middle";
  dimCtx.fillText(label, labelX + 8, labelY + labelH / 2 + 1);
}

// ── 操作条 ────────────────────────────────────────────────

function showToolbar(): void {
  const rect = canvas.getBoundingClientRect();
  const ratioX = rect.width / canvas.width;
  const ratioY = rect.height / canvas.height;
  const sx = selection.x * ratioX;
  const sy = selection.y * ratioY;
  const sw = selection.w * ratioX;
  const sh = selection.h * ratioY;

  // 操作条放在选区下方居中
  toolbar.style.display = "flex";
  toolbar.style.left = `${sx + sw / 2}px`;
  toolbar.style.top = `${sy + sh + 8}px`;
  toolbar.style.transform = "translateX(-50%)";
}

function hideToolbar(): void {
  toolbar.style.display = "none";
}

// ── 状态转移 ──────────────────────────────────────────────

function setState(next: State): void {
  state = next;
}

function clearSelection(): void {
  selection = { x: 0, y: 0, w: 0, h: 0 };
  hideToolbar();
  redrawDimmer();
}

// ── Pointer 事件 ──────────────────────────────────────────

function getCanvasPos(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const ratioX = canvas.width / rect.width;
  const ratioY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * ratioX,
    y: (e.clientY - rect.top) * ratioY,
  };
}

function onPointerDown(e: PointerEvent): void {
  if (state !== "idle" && state !== "selected") return;
  activePointerId = e.pointerId;
  canvas.setPointerCapture(e.pointerId);

  const pos = getCanvasPos(e);
  startPos = pos;
  selection = { x: pos.x, y: pos.y, w: 0, h: 0 };
  setState("selecting");
  hideToolbar();
  hintEl.classList.add("is-hidden");
}

function onPointerMove(e: PointerEvent): void {
  if (state !== "selecting" || e.pointerId !== activePointerId) return;
  const pos = getCanvasPos(e);
  selection = {
    x: Math.min(startPos.x, pos.x),
    y: Math.min(startPos.y, pos.y),
    w: Math.abs(pos.x - startPos.x),
    h: Math.abs(pos.y - startPos.y),
  };
  redrawDimmer();
}

function onPointerUp(e: PointerEvent): void {
  if (state !== "selecting" || e.pointerId !== activePointerId) return;
  if (activePointerId !== null) {
    canvas.releasePointerCapture(activePointerId);
    activePointerId = null;
  }

  if (selection.w < MIN_SELECTION_SIZE || selection.h < MIN_SELECTION_SIZE) {
    // 太小视为误触，不进入 selected
    clearSelection();
    setState("idle");
    return;
  }

  setState("selected");
  showToolbar();
}

function onDblClick(e: MouseEvent): void {
  if (state !== "selected") return;
  // 双击在选区内 -> 确认
  e.preventDefault();
  void confirmSelection();
}

function onKeyDown(e: KeyboardEvent): void {
  if (state === "idle") return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    cancelSelection("user-escape");
  } else if (e.key === "Enter" && state === "selected") {
    e.preventDefault();
    void confirmSelection();
  }
}

async function confirmSelection(): Promise<void> {
  if (state !== "selected") return;
  setState("submitting");

  timings.selectionConfirmed = Date.now();

  // 裁剪到临时 canvas
  const x = Math.round(selection.x);
  const y = Math.round(selection.y);
  const w = Math.round(selection.w);
  const h = Math.round(selection.h);
  // 边界 clamp
  const cx = Math.max(0, Math.min(x, canvas.width - 1));
  const cy = Math.max(0, Math.min(y, canvas.height - 1));
  const cw = Math.max(1, Math.min(w, canvas.width - cx));
  const ch = Math.max(1, Math.min(h, canvas.height - cy));

  const crop = document.createElement("canvas");
  crop.width = cw;
  crop.height = ch;
  const cropCtx = crop.getContext("2d")!;
  cropCtx.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);

  const blob: Blob = await new Promise((resolve, reject) => {
    crop.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("toBlob failed"));
    }, "image/png");
  });

  timings.pngEncoded = Date.now();
  const buf = await blob.arrayBuffer();
  window.screenshotOverlay.confirm({
    sessionId,
    png: buf,
    width: cw,
    height: ch,
    timings,
  });

  clearSelection();
  setState("idle");
}

function cancelSelection(reason: string): void {
  if (state === "idle") return;
  window.screenshotOverlay.cancel(sessionId, reason);
  clearSelection();
  setState("idle");
}

// ── 主流程 ────────────────────────────────────────────────

async function onStartSession(data: StartSessionData): Promise<void> {
  sessionId = data.sessionId;
  sessionFromButton = data.fromButton;
  displayW = data.displayWidth;
  displayH = data.displayHeight;
  timings = { ...data.timings };

  timings.frameRequested = Date.now();

  // 确保覆盖窗 canvas 与主屏 bounds 一致
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  // 确保流可用
  if (!streamReady) {
    await initStream();
  }

  if (!streamReady) {
    // 流失败 -- 通知主进程取消
    cancelSelection("stream-unavailable");
    return;
  }

  try {
    await captureFrameToCanvas();
  } catch {
    cancelSelection("frame-capture-failed");
    return;
  }

  capturedFrameWidth = canvas.width;
  capturedFrameHeight = canvas.height;
  timings.frameAvailable = Date.now();
  timings.canvasPainted = Date.now();

  // 通知主进程帧就绪 -> 主进程 show + focus
  window.screenshotOverlay.frameReady(sessionId, timings);
}

function onShown(): void {
  // 窗口已显示，重新画一次（因为窗口刚 show，可能需要再触发一次绘制）
  redrawDimmer();
  hintEl.classList.add("is-hidden");
}

// ── 初始化 ────────────────────────────────────────────────

async function init(): Promise<void> {
  // Canvas 自适应窗口尺寸
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  dimmer.width = window.innerWidth;
  dimmer.height = window.innerHeight;

  window.addEventListener("resize", () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    dimmer.width = window.innerWidth;
    dimmer.height = window.innerHeight;
    redrawDimmer();
  });

  // Pointer 事件
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("dblclick", onDblClick);

  // ESC / Enter 在捕获阶段拦截，避免被覆盖窗之外抢先消费
  window.addEventListener("keydown", onKeyDown, true);

  // 操作条按钮
  toolbarConfirm.addEventListener("click", () => void confirmSelection());
  toolbarCancel.addEventListener("click", () => cancelSelection("user-cancel"));

  // 接收会话
  window.screenshotOverlay.onStartSession((data) => void onStartSession(data));
  window.screenshotOverlay.onShown(() => onShown());

  // 通知主进程窗口 ready（用于会话级注册的握手）
  window.screenshotOverlay.ready();

  // 主动预热屏幕流（不等待用户操作）
  void initStream();
}

void init();