import { describe, expect, it, vi } from "vitest";
import { openPrimaryWindow } from "./primary-window";
import type { WindowActivationRequest } from "../application/window-activation";

describe("openPrimaryWindow", () => {
  it("routes activation through a chat request instead of opening windows directly", () => {
    const requests: WindowActivationRequest[] = [];

    openPrimaryWindow({
      requestActivation: (request) => {
        requests.push(request);
      },
    });

    expect(requests).toEqual([{ kind: "chat" }]);
  });

  it("never issues pet visibility through the generic activation request", () => {
    const requestActivation = vi.fn();

    openPrimaryWindow({ requestActivation });

    expect(requestActivation).toHaveBeenCalledOnce();
    expect(requestActivation.mock.calls[0][0].kind).not.toBe("sidebar");
    expect(requestActivation).toHaveBeenCalledWith({ kind: "chat" });
  });
});
