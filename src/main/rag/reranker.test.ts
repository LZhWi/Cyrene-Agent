import { describe, expect, it, vi } from "vitest";
import { rerankDocumentsWithPipeline } from "./reranker";

describe("cross-encoder reranker input", () => {
  it("passes query/document pairs through tokenizer text_pair and sorts raw logits", async () => {
    const tokenizer = vi.fn(() => ({ input_ids: "encoded" }));
    const model = vi.fn(async () => ({
      logits: [
        { data: new Float32Array([-1.5]) },
        { data: new Float32Array([2.25]) },
      ],
    }));

    const results = await rerankDocumentsWithPipeline(
      { tokenizer, model },
      "query",
      ["less relevant", "more relevant"],
    );

    expect(tokenizer).toHaveBeenCalledWith(
      ["query", "query"],
      { text_pair: ["less relevant", "more relevant"], padding: true, truncation: true },
    );
    expect(model).toHaveBeenCalledWith({ input_ids: "encoded" });
    expect(results).toEqual([
      { text: "more relevant", score: 2.25 },
      { text: "less relevant", score: -1.5 },
    ]);
  });
});
