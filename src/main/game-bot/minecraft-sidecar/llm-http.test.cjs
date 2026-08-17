"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchWithRetry, retryDelayMs } = require("./llm-http.cjs");

test("uses bounded exponential backoff with jitter", () => {
  assert.equal(retryDelayMs(0, () => 0), 500);
  assert.equal(retryDelayMs(1, () => 0.5), 1125);
  assert.equal(retryDelayMs(9, () => 0), 4000);
});

test("retries rate limits and temporary provider failures", async () => {
  const statuses = [429, 503, 200];
  const delays = [];
  const response = await fetchWithRetry(
    async () => ({ ok: statuses[0] === 200, status: statuses.shift() }),
    "https://example.test", {},
    { sleepImpl: async (ms) => delays.push(ms), random: () => 0 },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(delays, [500, 1000]);
});

test("retries transient network errors but not authentication failures", async () => {
  let networkCalls = 0;
  const recovered = await fetchWithRetry(async () => {
    networkCalls += 1;
    if (networkCalls === 1) throw new TypeError("temporary network failure");
    return { ok: true, status: 200 };
  }, "https://example.test", {}, { sleepImpl: async () => {}, random: () => 0 });
  assert.equal(recovered.status, 200);
  assert.equal(networkCalls, 2);

  let authCalls = 0;
  const unauthorized = await fetchWithRetry(async () => {
    authCalls += 1;
    return { ok: false, status: 401 };
  }, "https://example.test", {}, { sleepImpl: async () => {}, random: () => 0 });
  assert.equal(unauthorized.status, 401);
  assert.equal(authCalls, 1);
});
