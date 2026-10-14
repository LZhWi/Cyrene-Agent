import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { startProxy } = createRequire(import.meta.url)("./lib/proxy.cjs");

describe("OAuth image request size", () => {
  it("forwards image bodies larger than 2 MiB without changing their contents", async () => {
    const imageUrl = `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`;
    const fetchImpl = vi.fn(async () => new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'));
    const proxy = await startProxy({ oauth: { accessToken: async () => "test-token" }, fetchImpl });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${proxy.secret}` },
        body: JSON.stringify({ model: "test-model", input: [{ role: "user", content: [{ type: "input_image", image_url: imageUrl }] }] }),
      });
      expect(response.status).toBe(200);
      const wire = JSON.parse((fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0][1].body as string);
      expect(wire.input[0].content[0].image_url).toBe(imageUrl);
    } finally { await proxy.close(); }
  });

  it("still rejects oversized input before obtaining credentials or calling upstream", async () => {
    const accessToken = vi.fn(), fetchImpl = vi.fn();
    const proxy = await startProxy({ oauth: { accessToken }, fetchImpl });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${proxy.secret}` }, body: "A".repeat(32 * 1024 * 1024 + 1),
      });
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("32 MiB limit");
      expect(accessToken).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { await proxy.close(); }
  });
});
