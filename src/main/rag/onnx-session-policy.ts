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
      const ort = transformers.env?.backends?.onnx?.runtime ?? require("onnxruntime-node");
      const sessionCtor = ort?.InferenceSession;
      if (!sessionCtor || typeof sessionCtor.create !== "function") return;
      const originalCreate = sessionCtor.create.bind(sessionCtor);
      sessionCtor.create = (model: unknown, options: Record<string, unknown> = {}) => originalCreate(model, {
        ...options,
        intraOpNumThreads: INTRA_OP_THREADS,
        interOpNumThreads: 1,
      });
      applied = true;
      console.log(`[ONNX] session policy applied: intraOpNumThreads=${INTRA_OP_THREADS}, interOpNumThreads=1`);
    } catch (error) {
      console.warn("[ONNX] session policy apply failed:", error);
    }
  })();
  return applyPromise;
}

export function resetOnnxSessionPolicyForTests(): void {
  applied = false;
  applyPromise = null;
}
