# Structured Output Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CITA and Action Gate virtual Function Calling with one provider-aware, fail-closed Structured Output Pipeline, replace the built-in Volcengine AgentPlan preset with Doubao, and keep custom/local endpoints permanently on prompt JSON mode.

**Architecture:** Provider/model profiles select only the wire constraint (`json_schema`, `json_object`, or prompt JSON). A shared local pipeline normalizes responses, extracts every JSON object candidate, accepts exactly one schema-valid and business-trusted value, classifies failures, and performs bounded repair. Native Function Calling remains separate and may execute only after a trusted Action Gate `act` decision.

**Tech Stack:** Electron, TypeScript 5.6, Vitest 4, LangGraph, OpenAI-compatible Chat Completions, Anthropic Messages.

## Global Constraints

- Built-in `volcengine` / 火山 AgentPlan is removed and replaced by `doubao` / 豆包（火山方舟）.
- Custom and local endpoints are permanently `prompt_json`; no A/B probing or automatic promotion.
- CITA and Action Gate never use virtual tools after migration.
- Only locally validated values may enter routing, Native FC, execution, or Soul.
- CITA is bounded by two total attempts; D tier keeps the 8-second baseline, A tier uses 20 seconds, B tier uses 16 seconds, and MiniMax M tier uses 10 seconds.
- Action Gate is bounded by two total attempts; D tier keeps the 10-second baseline, A tier uses 25 seconds, B tier uses 20 seconds, and MiniMax M tier uses 12 seconds.
- Kimi K2.7 Code, K3, and the `kimi-for-coding` TokenPlan alias override only the CITA budget to 40 seconds total and 20 seconds per attempt; K2.6 keeps the standard A-tier budget.
- Native FC keeps real business tools and gets at most one protocol repair.
- Existing user changes from baseline commit `666c317` must be preserved.

---

### Task 1: Replace Volcengine AgentPlan with Doubao

**Files:**
- Modify: `src/main/orchestrator/vendors/capabilities.ts`
- Modify: `src/renderer/settings/settings.ts`
- Modify: `src/shared/reasoning.ts`
- Modify: `src/main/index.ts`
- Modify: provider/reasoning tests containing `volcengine`

**Interfaces:**
- Produces: built-in provider id `doubao`, display name `豆包（火山方舟）`, base URL `https://ark.cn-beijing.volces.com/api/v3`.
- Produces: old AgentPlan values no longer resolve as a built-in provider.

- [x] Write failing tests asserting `PROVIDER_CAPABILITIES` contains `doubao` and no `volcengine`.
- [x] Run the focused provider/reasoning tests and verify they fail on the old preset.
- [x] Replace the preset, reasoning rule, labels, icon metadata, short-name mapping, and tests.
- [x] Run the focused tests and `npm run build:main`.

### Task 2: Add Structured Output Profiles and Request Types

**Files:**
- Create: `src/main/orchestrator/structured-output/types.ts`
- Create: `src/main/orchestrator/structured-output/profiles.ts`
- Create: `src/main/orchestrator/structured-output/profiles.test.ts`
- Modify: `src/main/orchestrator/vendors/types.ts`

**Interfaces:**
- Produces: `StructuredOutputMode = "provider_json_schema" | "provider_json_object" | "prompt_json"`.
- Produces: `resolveStructuredOutputProfile({ provider, model, transport })`.
- Produces: `ChatRequest.structuredOutput` as an explicit transport-neutral request contract.

- [x] Write table-driven failing tests for OpenAI/Claude/Kimi/Doubao A, DeepSeek/Qwen/GLM/MiMo B, MiniMax M, and unknown/custom D.
- [x] Verify the tests fail because the resolver does not exist.
- [x] Implement exact model matchers, conservative unknown fallback, stage repair policy, and transport-neutral request types.
- [x] Run the profile tests and typecheck.

### Task 3: Implement Provider Request Builders

**Files:**
- Modify: `src/main/orchestrator/vendors/openai-adapter.ts`
- Modify: `src/main/orchestrator/vendors/anthropic-adapter.ts`
- Modify: corresponding adapter tests

**Interfaces:**
- Consumes: `ChatRequest.structuredOutput`.
- Produces: OpenAI-compatible `response_format` or Anthropic `output_config.format`.

- [x] Write failing adapter tests for OpenAI `json_schema`, OpenAI `json_object`, Claude `output_config.format`, and MiniMax prompt mode with JSON hint.
- [x] Verify each test fails on missing wire fields.
- [x] Implement request translation without using tools or `tool_choice`.
- [x] Run adapter tests and ensure Native FC tests still pass.

### Task 4: Implement Normalization and JSON Candidate Extraction

**Files:**
- Create: `src/main/orchestrator/structured-output/finish-reason.ts`
- Create: `src/main/orchestrator/structured-output/json-candidates.ts`
- Create: focused tests for both modules

**Interfaces:**
- Produces: normalized finish states `complete`, `truncated`, `tool_call`, `content_filtered`, `refused`, `unknown`.
- Produces: `extractJsonCandidates(text): JsonCandidate[]`.

- [x] Write failing tests for direct JSON, fenced JSON, prose, escaped quotes, braces in strings, nesting, duplicate extraction, multiple objects, arrays, scalars, and truncated objects.
- [x] Write failing tests for OpenAI and Anthropic finish-reason mappings.
- [x] Implement string-aware brace scanning and structural candidate deduplication.
- [x] Run focused tests.

### Task 5: Implement the Shared Runner, Validation, Repair, and Metrics

**Files:**
- Create: `src/main/orchestrator/structured-output/runner.ts`
- Create: `src/main/orchestrator/structured-output/errors.ts`
- Create: `src/main/orchestrator/structured-output/metrics.ts`
- Create: runner tests

**Interfaces:**
- Produces: `runStructuredOutput<T>(input): Promise<StructuredOutputRunResult<T>>`.
- Produces: explicit success or trusted failure with `toolExecuted: false`.

- [x] Write failing tests for first-pass success, unique valid candidate, ambiguous valid candidates, truncated repair, missing-information bypass, expired-state bypass, refusal, network failure, repair exhaustion, and deadline exhaustion.
- [x] Verify the tests fail on the missing runner.
- [x] Implement absolute deadline handling, per-attempt abort, structured error codes, two repair shapes, and metrics without raw private content.
- [x] Run runner tests.

### Task 6: Migrate CITA

**Files:**
- Modify: `src/main/cita/semantic-engine.ts`
- Modify: `src/main/cita/remote-semantic-engine.ts`
- Modify: `src/main/cita/schema.ts`
- Modify: `src/main/cita/cita-service.ts`
- Modify: `src/main/index.ts`
- Modify: `prompts/cita_system.md`
- Modify: CITA tests

**Interfaces:**
- Consumes: shared Structured Output runner.
- Produces: trusted `TurnUnderstanding` or deterministic degraded/unavailable CITA facts.

- [x] Rewrite CITA tests to expect structured text requests with no tools or tool choice and verify failure first.
- [x] Replace the FC schema with a JSON Schema matching `TurnUnderstanding`.
- [x] Route generation through the shared runner and existing `parseTurnUnderstanding` plus `validateUnderstanding`.
- [x] Remove `submit_context_understanding`, `FcUnderstandingResult`, and FC adaptation.
- [x] Run all CITA tests and build.

### Task 7: Migrate Action Gate and Add Explicit Failure Routing

**Files:**
- Modify: `src/main/orchestrator/action-gate.ts`
- Modify: `src/main/orchestrator/langgraph-agent-loop.ts`
- Modify: `src/main/orchestrator/agent-graph.ts`
- Modify: `src/main/agui-bridge.ts`
- Modify: `prompts/action_gate_system.md`
- Modify: Action Gate and graph tests

**Interfaces:**
- Consumes: shared Structured Output runner.
- Produces: `TrustedActionDecision` or explicit `TrustedFailureFact`.

- [x] Rewrite Action Gate tests to require no virtual tools and verify they fail.
- [x] Build the Action Decision JSON Schema and local parser/business validator.
- [x] Replace `ActionGateStrategy`, virtual tool parsing, and one-off repair with the shared runner.
- [x] Add a graph failure route whose Soul input contains only local failure facts and `toolExecuted: false`.
- [x] Run Action Gate, graph, AG-UI, and build tests.

### Task 8: Verify Native FC Boundary and Remove Old Protocol

**Files:**
- Modify: `src/main/orchestrator/native-function-calling.ts`
- Modify: `src/main/orchestrator/tool-argument-validator.ts`
- Delete or reduce: `src/main/orchestrator/vendors/action-gate-profiles.ts`
- Modify: Native FC and regression tests

**Interfaces:**
- Consumes: trusted `act` decision.
- Produces: one real tool call matching the approved capability and refs, or trusted failure.

- [x] Write failing tests proving ordinary text never counts as execution and only one repair is attempted.
- [x] Enforce one exposed tool, matching tool name, approved refs, argument schema, and execution ledger checks.
- [x] Remove virtual Action Gate/CITA FC profiles and stale protocol branches.
- [x] Run `npm run build:main`, `npm test`, and `npm run smoke:music`.
