import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
const { JSDOM } = require("jsdom");

describe("Furina file tool panel", () => {
  it("exposes HTML rendering and extraction through both manual buttons", async () => {
    const root = path.resolve("plugins/furina-file-tools/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const window = dom.window;
    const calls: Array<{ action: string; data: unknown }> = [];
    window.furina = { invoke: async (action: string, data: unknown) => { calls.push({ action, data }); return { ok: true, data: { workspace: "E:/test", inputs: ["input.html"], modelAvailable: true, model: { running: false, text: "", error: "", event: "" } } }; } };
    window.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => window.document.getElementById(id);
    try {
      await vi.waitFor(() => expect(el("workspace").textContent).toBe("E:/test"));
      el("tool").value = "html-to-image"; el("tool").dispatchEvent(new window.Event("change"));
      expect(el("html-fields").hidden).toBe(false); expect(el("html-image-fields").hidden).toBe(false);
      el("direct").click();
      await vi.waitFor(() => expect(calls).toContainEqual({ action: "submit", data: { tool: "html-to-image", parameters: { method: "render", width: 1200, height: 900, wait_ms: 1500 } } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      el("html-method").value = "extract"; el("html-method").dispatchEvent(new window.Event("change"));
      expect(el("html-render-fields").hidden).toBe(true);
      el("model").click();
      await vi.waitFor(() => expect(calls).toContainEqual({ action: "model-start", data: { tool: "html-to-image", parameters: { method: "extract" } } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally { dom.window.close(); }
  });
  it("separates direct/model actions and renders untrusted paths as text", async () => {
    const root = path.resolve("plugins/furina-file-tools/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const window = dom.window;
    const calls: Array<{ action: string; data: unknown }> = [];
    const state = { workspace: "E:/test", inputs: ["<img src=x onerror=alert(1)>.png"], modelAvailable: true,
      model: { running: false, text: "", error: "", event: "" } };
    window.furina = { invoke: async (action: string, data: unknown) => { calls.push({ action, data }); return { ok: true, data: state }; } };
    window.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => window.document.getElementById(id);
    try {
      await vi.waitFor(() => expect(el("workspace").textContent).toBe("E:/test"));
      expect(el("direct").disabled).toBe(false);
      expect(el("files").querySelector("img")).toBeNull();
      el("tool").value = "image-convert"; el("tool").dispatchEvent(new window.Event("change")); el("format").value = "jpg";
      el("direct").click();
      await vi.waitFor(() => expect(calls).toContainEqual({ action: "submit", data: { tool: "image-convert", parameters: { format: "jpg" } } }));
      expect(calls.some((call) => call.action === "model-start")).toBe(false);
      await vi.waitFor(() => expect(el("model").disabled).toBe(false));
      el("model").click();
      await vi.waitFor(() => expect(calls).toContainEqual({ action: "model-start", data: { tool: "image-convert", parameters: { format: "jpg" } } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(el("model").disabled).toBe(false);
      expect(el("convert-fields").hidden).toBe(false); expect(el("compress-fields").hidden).toBe(true);
    } finally { dom.window.close(); }
  });

  it("keeps direct execution available when the model service is unsupported", async () => {
    const root = path.resolve("plugins/furina-file-tools/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const window = dom.window;
    window.furina = { invoke: async () => ({ ok: true, data: { workspace: "E:/test", inputs: ["input.png"], modelAvailable: false,
      model: { running: false, text: "", error: "", event: "" } } }) };
    window.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    try {
      await vi.waitFor(() => expect(window.document.getElementById("workspace").textContent).toBe("E:/test"));
      expect(window.document.getElementById("direct").disabled).toBe(false);
      expect(window.document.getElementById("model").disabled).toBe(true);
      expect(window.document.getElementById("model-unavailable").hidden).toBe(false);
    } finally { dom.window.close(); }
  });
});
