// ONNX Runtime 会话级 CPU 策略：限制推理线程数，避免整机 CPU 饱和。
//
// 背景：transformers.js v2 的 constructSession 只传 executionProviders，不暴露线程配置；
// onnxruntime-node 默认 intraOpNumThreads = 物理核数，本机 24 核会被单次推理瞬间打满，
// Live2D/Minecraft/桌面全部掉帧（用户感知"每发一条消息卡 2 秒"的直接原因）。
//
// 手段：包装 InferenceSession.create 注入线程上限。transformers.js 通过 webpack external
// 在运行时 require 同一个 onnxruntime-node 模块实例，因此补丁对它的 pipeline 同样生效。
// 线程数只改并行度不改计算，检索数值结果不变（浮点归约序差异 ~1e-7，不影响排序）。

// 与 Ultra 9 290HX Plus 的 P 核数对齐：保住爆发性能，又不越界吃满 E 核全家。
const INTRA_OP_THREADS = 8;

const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

let applied = false;
let applyPromise: Promise<void> | null = null;

export function applyOnnxCpuSessionPolicy(): Promise<void> {
  if (applied) return Promise.resolve();
  if (applyPromise) return applyPromise;
  applyPromise = (async () => {
    try {
      const transformers = await importEsm("@xenova/transformers");
      // transformers.js 在 Node 下经 external require 同一份 onnxruntime-node；
      // 经由它解析能保证补丁命中的是 pipeline 实际使用的模块实例。
      const ort = transformers.env?.backends?.onnx?.runtime
        ?? require("onnxruntime-node");
      const sessionCtor = ort?.InferenceSession;
      if (!sessionCtor || typeof sessionCtor.create !== "function") return;
      const originalCreate = sessionCtor.create.bind(sessionCtor);
      sessionCtor.create = (model: unknown, options: Record<string, unknown> = {}) =>
        originalCreate(model, {
          ...options,
          intraOpNumThreads: INTRA_OP_THREADS,
          interOpNumThreads: 1,
        });
      applied = true;
      console.log(`[ONNX] session policy applied: intraOpNumThreads=${INTRA_OP_THREADS}, interOpNumThreads=1`);
    } catch (error) {
      // 限流是体验优化不是功能依赖：失败回退默认行为，不阻塞模型加载。
      console.warn("[ONNX] session policy apply failed:", error);
    }
  })();
  return applyPromise;
}

/** 测试钩子：重置补丁状态（生产代码不应调用）。 */
export function resetOnnxSessionPolicyForTests(): void {
  applied = false;
  applyPromise = null;
}
