import { describe, expect, it } from "vitest";
import { workspacePaste } from "./workspace-paste";
import { filterSlashSkillSuggestions, getActiveSlashSkillToken, replaceSlashSkill } from "./slashSkillSuggestions";

describe("workspace composer input", () => {
  const data = (types: string[], files: unknown[] = [], uri = "") => ({ types, files, items: [], getData: () => uri }) as unknown as DataTransfer;
  it("routes pasted documents and mixed files to the existing file entry", () => {
    const files = [{ name: "a.txt", type: "text/plain" }, { name: "a.png", type: "image/png" }];
    expect(workspacePaste(data(["Files"], files))).toEqual({ kind: "files", files });
  });
  it("keeps plain/rich text and image-only paste on their existing routes", () => {
    const image = { name: "a.png", type: "image/png" };
    expect(workspacePaste(data(["text/plain", "Files"], [image]))).toBeNull();
    expect(workspacePaste(data(["Files"], [image]))).toBeNull();
    expect(workspacePaste(data(["text/plain"], [{ name: "a.txt", type: "text/plain" }]))).toBeNull();
  });
  it("accepts file URI lists but not pasted web links", () => {
    expect(workspacePaste(data(["text/uri-list"], [], "file:///C:/test.txt"))?.kind).toBe("uris");
    expect(workspacePaste(data(["text/uri-list"], [], "https://example.com"))).toBeNull();
  });
  it("only completes the leading slash token under a collapsed cursor", () => {
    expect(getActiveSlashSkillToken("/te rest", 3, 3)).toEqual({ query: "te", end: 3 });
    for (const [text, start, end] of [["x /te", 5, 5], ["/te rest", 7, 7], ["/te", 1, 3]] as const)
      expect(getActiveSlashSkillToken(text, start, end)).toBeNull();
    expect(replaceSlashSkill("/te rest", 3, "test")).toBe("/test rest");
    expect(replaceSlashSkill("/te", 3, "test")).toBe("/test ");
  });
  it("filters suggestions without changing their IDs", () => {
    const skills = ["my-test", "test"].map((id) => ({ id, name: id, description: "", source: "user" as const }));
    expect(filterSlashSkillSuggestions(skills, "TE").map((s) => s.id)).toEqual(["test", "my-test"]);
  });
});
