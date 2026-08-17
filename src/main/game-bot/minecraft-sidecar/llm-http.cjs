"use strict";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryDelayMs(retryIndex, random = Math.random) {
  const base = Math.min(4000, 500 * (2 ** retryIndex));
  return base + Math.floor(random() * 250);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(fetchImpl, url, options, retryOptions = {}) {
  const sleepImpl = retryOptions.sleepImpl || wait;
  const random = retryOptions.random || Math.random;
  const maxAttempts = Math.max(1, Math.min(5, retryOptions.maxAttempts || 3));
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, options);
      if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts - 1) return response;
    } catch (error) {
      if (error?.name === "AbortError" || attempt === maxAttempts - 1) throw error;
      lastError = error;
    }
    await sleepImpl(retryDelayMs(attempt, random));
  }

  throw lastError || new Error("LLM request failed");
}

module.exports = { RETRYABLE_STATUS, fetchWithRetry, retryDelayMs };
