import { describe, expect, it, vi, beforeEach } from "vitest";

import { registerSearchProfile } from "./search-agent";
import { isProfileRegistered } from "./runner";

describe("Search Agent Profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers search profile correctly", () => {
    registerSearchProfile();
    expect(isProfileRegistered("search")).toBe(true);
  });
});
