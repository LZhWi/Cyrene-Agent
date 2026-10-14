import { describe, expect, it } from "vitest";
import { classifyModelFailure } from "./model-error-classifier";

describe("classifyModelFailure", () => {
  it("keeps a provider code, status and request ID without exposing the response body", () => {
    const failure = classifyModelFailure({
      provider: "glm", model: "glm-4.1v", status: 429,
      error: { error: { code: "1302", message: "Authorization: secret-value" }, request_id: "request-1" },
    });
    expect(failure).toMatchObject({
      provider: "glm", model: "glm-4.1v", category: "RATE_LIMIT", status: 429,
      vendorCode: "1302", requestId: "request-1", retryable: true,
    });
    expect(JSON.stringify(failure)).not.toContain("secret-value");
  });

  it("uses structured protocol details for a failed Responses stream", () => {
    expect(classifyModelFailure({
      provider: "openai", model: "gpt-test",
      error: { name: "ProviderProtocolError", code: "E_UNSUPPORTED_STREAM_EVENT", providerDetails: {
        vendorCode: "credit_balance_exhausted", requestId: "response-1",
      } },
    })).toMatchObject({ provider: "chatgpt", category: "BILLING", requestId: "response-1" });
  });

  it("does not guess a billing error from unstructured provider prose", () => {
    expect(classifyModelFailure({ provider: "chatgpt", model: "gpt-test", error: new Error("payment required") }).category)
      .toBe("UNKNOWN");
  });

  it("does not expose credential-like values in structured metadata", () => {
    const failure = classifyModelFailure({
      provider: "glm", model: "glm-test", status: 401,
      error: { error: { code: "api_key=secret-value" }, request_id: "Bearer token-value" },
    });
    expect(failure.category).toBe("UNKNOWN");
    expect(failure.vendorCode).toBeUndefined();
    expect(failure.requestId).toBeUndefined();
  });
});
