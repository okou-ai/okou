import { describe, expect, it } from "vitest";

import {
  claudeToolEntrySchema,
  getRunResponseSchema,
  networkLogEntrySchema,
  unifiedRunRequestSchema,
} from "../runs";
import { triggerSourceSchema } from "../logs";
import { runCreateBodySchema } from "../run-routes";

describe("get run response contract", () => {
  it("keeps the additive source readable across old and new run decoders", () => {
    const legacyDecoder = getRunResponseSchema.omit({ source: true });
    const historical = {
      runId: "run-1",
      status: "failed",
      prompt: "inspect the run",
      appendSystemPrompt: null,
      createdAt: "2026-08-21T00:00:00.000Z",
    };
    const extended = {
      ...historical,
      source: {
        providerType: "codex-oauth-token",
        runtimeProviderType: null,
        model: "gpt-5.6-sol",
        credentialScope: "member",
        account: { status: "unknown" },
      },
    };
    expect(legacyDecoder.parse(extended)).toEqual(historical);
    expect(getRunResponseSchema.parse(historical)).toEqual(historical);
    expect(getRunResponseSchema.parse(extended)).toEqual(extended);
  });
  it("parses the current Run response", () => {
    const response = getRunResponseSchema.parse({
      runId: "run-1",
      status: "pending",
      prompt: "inspect the run",
      appendSystemPrompt: null,
      createdAt: "2026-08-21T00:00:00.000Z",
    });

    expect(response).toStrictEqual({
      runId: "run-1",
      status: "pending",
      prompt: "inspect the run",
      appendSystemPrompt: null,
      createdAt: "2026-08-21T00:00:00.000Z",
    });
  });
});

describe("Claude tool entry contract", () => {
  it("accepts single Claude tool names", () => {
    expect(claudeToolEntrySchema.safeParse("Bash").success).toBe(true);
    expect(claudeToolEntrySchema.safeParse("mcp__github__search").success).toBe(
      true,
    );
  });

  it("rejects ambiguous Claude tool entries", () => {
    for (const tool of ["", "   ", "Bash,Read", "--help", " -x"]) {
      expect(claudeToolEntrySchema.safeParse(tool).success).toBe(false);
    }
  });
});

describe("unified run request contract", () => {
  it("keeps historical Goal sources readable while accepting only supported live sources", () => {
    expect(triggerSourceSchema.parse("goal")).toBe("goal");
    expect(
      runCreateBodySchema.safeParse({
        prompt: "old request",
        triggerSource: "goal",
      }).success,
    ).toBe(false);
    const input = { agentId: "agent-1", prompt: "ordinary work" };
    expect(
      unifiedRunRequestSchema.safeParse({ ...input, triggerSource: "goal" })
        .success,
    ).toBe(false);
    expect(
      unifiedRunRequestSchema.safeParse({ ...input, triggerSource: "web" })
        .success,
    ).toBe(true);
  });

  it("accepts Agent-backed creation and Session-backed continuation", () => {
    expect(
      unifiedRunRequestSchema.safeParse({
        agentId: "agent-1",
        prompt: "start a run",
      }).success,
    ).toBe(true);
    expect(
      unifiedRunRequestSchema.safeParse({
        sessionId: "session-1",
        prompt: "continue a run",
      }).success,
    ).toBe(true);
    expect(
      unifiedRunRequestSchema.safeParse({
        agentId: "agent-1",
        sessionId: "session-1",
        prompt: "continue a matching Agent Session",
      }).success,
    ).toBe(true);
  });

  it("rejects checkpoint resume requests", () => {
    expect(
      unifiedRunRequestSchema.safeParse({
        checkpointId: "11111111-1111-4111-8111-111111111111",
        prompt: "resume from checkpoint",
      }).success,
    ).toBe(false);
  });

  it("rejects built-in models for direct runs without credit admission", () => {
    expect(
      unifiedRunRequestSchema.safeParse({
        prompt: "run directly",
        modelProviderType: "built-in",
      }).success,
    ).toBe(false);
  });

  it("accepts the built-in provider on internal agent run requests", () => {
    expect(
      runCreateBodySchema.parse({
        prompt: "run through Okou",
        modelProvider: "built-in",
      }).modelProvider,
    ).toBe("built-in");
  });
});

describe("network log capture completeness", () => {
  const baseEntry = {
    timestamp: "2026-08-13T12:00:00.000Z",
    type: "http",
  };

  it("accepts independent request and response header truncation state", () => {
    expect(
      networkLogEntrySchema.safeParse({
        ...baseEntry,
        request_headers: { accept: "application/json" },
        request_headers_truncated: true,
        response_headers: { server: "***" },
        response_headers_truncated: false,
      }).success,
    ).toBe(true);
  });

  it("rejects non-boolean header truncation state", () => {
    for (const invalidEntry of [
      { request_headers_truncated: "true" },
      { response_headers_truncated: 1 },
    ]) {
      expect(
        networkLogEntrySchema.safeParse({
          ...baseEntry,
          ...invalidEntry,
        }).success,
      ).toBe(false);
    }
  });
});

describe("network log model catalog cache telemetry", () => {
  const baseEntry = {
    timestamp: "2026-07-27T12:00:00.000Z",
    type: "http",
  };

  it("accepts bounded cache outcome fields", () => {
    expect(
      networkLogEntrySchema.safeParse({
        ...baseEntry,
        model_catalog_cache_status: "model_catalog_revalidated_200_same",
        model_catalog_cache_upstream_encoding: "br",
        model_catalog_cache_bypass_reason: "response_cache_control",
        model_catalog_cache_entry_age_ms: 61_000,
        model_catalog_cache_validation_latency_ms: 1700,
        model_catalog_cache_eviction_count: 1,
        model_catalog_prefetch_role: "inflight_consumer",
      }).success,
    ).toBe(true);
  });

  it("rejects cache outcome values outside the declared vocabulary", () => {
    expect(
      networkLogEntrySchema.safeParse({
        ...baseEntry,
        model_catalog_cache_status: "credential-specific-value",
      }).success,
    ).toBe(false);
    expect(
      networkLogEntrySchema.safeParse({
        ...baseEntry,
        model_catalog_cache_upstream_encoding: "gzip",
      }).success,
    ).toBe(false);
    expect(
      networkLogEntrySchema.safeParse({
        ...baseEntry,
        model_catalog_cache_bypass_reason: "provider-body-details",
      }).success,
    ).toBe(false);
    expect(
      networkLogEntrySchema.safeParse({
        ...baseEntry,
        model_catalog_prefetch_role: "account-specific-value",
      }).success,
    ).toBe(false);
  });

  it("rejects cache telemetry numbers outside their bounds", () => {
    for (const invalidEntry of [
      { model_catalog_cache_entry_age_ms: -1 },
      { model_catalog_cache_entry_age_ms: 1.5 },
      { model_catalog_cache_entry_age_ms: 2_147_483_648 },
      { model_catalog_cache_validation_latency_ms: -1 },
      { model_catalog_cache_validation_latency_ms: Number.POSITIVE_INFINITY },
      { model_catalog_cache_eviction_count: -1 },
      { model_catalog_cache_eviction_count: 1.5 },
      { model_catalog_cache_eviction_count: 33 },
    ]) {
      expect(
        networkLogEntrySchema.safeParse({
          ...baseEntry,
          ...invalidEntry,
        }).success,
      ).toBe(false);
    }
  });
});
