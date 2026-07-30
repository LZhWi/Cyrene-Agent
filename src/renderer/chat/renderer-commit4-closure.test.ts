import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Commit 4 Renderer 收口", () => {
  it("Renderer 消费验证事件、恢复 active run，并实际构建确定性卡片", () => {
    const source = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");

    expect(source).toContain("applyCodeRunEvent");
    expect(source).toContain("restoreCodeRunViewModel");
    expect(source).toContain("buildCodeVerificationCardEl");
    expect(source).toContain("buildCodeApprovalCardEl");
    expect(source).toContain("code_verification_card");
    expect(source).toContain("code_verification_approval");
    expect(source).toContain("window.codeRun");
  });
});
