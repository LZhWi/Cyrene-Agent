import { describe, expect, it, vi } from "vitest";
import { connectStartupItems } from "./startup-connections";

describe("startup connection isolation", () => {
  it("starts independent connections concurrently", async () => {
    const releases: Array<() => void> = [];
    const connect = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const pending = connectStartupItems(["a", "b", "c"], connect, vi.fn());

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    releases.forEach((release) => release());

    await expect(pending).resolves.toEqual({ connected: 3, failed: 0 });
  });

  it("contains one failure without cancelling siblings", async () => {
    const onFailure = vi.fn();
    const result = await connectStartupItems(
      ["good-a", "bad", "good-b"],
      async (item) => {
        if (item === "bad") throw new Error("offline");
      },
      onFailure,
    );

    expect(result).toEqual({ connected: 2, failed: 1 });
    expect(onFailure).toHaveBeenCalledWith("bad", expect.objectContaining({ message: "offline" }));
  });
});
