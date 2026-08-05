import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("local ASR model preparation", () => {
  it("separates resumable model download from model loading", () => {
    const worker = fs.readFileSync(path.resolve(process.cwd(), "local_asr/worker.py"), "utf8");
    const runtime = fs.readFileSync(path.resolve(process.cwd(), "src/main/asr/local-asr-engine.ts"), "utf8");

    expect(worker).toContain("snapshot_download(checkpoint, local_files_only=True)");
    expect(worker).toContain("missing_snapshot_weights(model_path)");
    expect(worker).toContain("hf_hub_download(repo_id=checkpoint, filename=filename)");
    expect(worker).toContain('emit("status", phase="downloading"');
    expect(worker).toContain('emit("status", phase="loading"');
    expect(runtime).toContain("const DOWNLOAD_TIMEOUT_MS = 60 * 60_000");
    expect(runtime).toContain("const MODEL_LOAD_TIMEOUT_MS = 10 * 60_000");
  });

  it("force-stops a worker that is busy downloading or loading", () => {
    const runtime = fs.readFileSync(path.resolve(process.cwd(), "src/main/asr/local-asr-engine.ts"), "utf8");
    expect(runtime).toMatch(/if \(this\.configureReject\) \{\s+child\.kill\(\)/);
  });

  it("flushes a short Paraformer tail without ending the ASR turn", () => {
    const worker = fs.readFileSync(path.resolve(process.cwd(), "local_asr/worker.py"), "utf8");
    expect(worker).toContain('elif kind == "flush"');
    expect(worker).toContain("self._drain_paraformer(session_id, session, is_final=True)");
    expect(worker).toContain("session.para_cache = {}");
    expect(worker).toContain("100 ms silence releases decoder lookahead");
  });

  it("restores punctuation before emitting the stable final transcript", () => {
    const worker = fs.readFileSync(path.resolve(process.cwd(), "local_asr/worker.py"), "utf8");

    expect(worker).toContain("ms_snapshot_download(");
    expect(worker).toContain("local_files_only=True");
    expect(worker).toContain("model=punc_model_path");
    expect(worker).toContain("text = self._restore_punctuation(text)");
    expect(worker).toMatch(/text = self\._restore_punctuation\(text\)\s+emit\("final"/);
    expect(worker).toContain("if SENTENCE_PUNCTUATION_RE.search(text)");
    expect(worker).toContain("REPEATED_PUNCTUATION_RE.sub");
    expect(worker).toContain("if context and text.startswith(context)");
  });
});
