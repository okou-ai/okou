import { screen, within } from "@testing-library/react";
import { getAction } from "./connector-integrations-test-helpers.ts";
import { claudeCodeDeviceAuthContract as claude } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { codexDeviceAuthContract as codex } from "@okouai/api-contracts/contracts/codex-device-auth";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export function personalAccount(
  provider: "Claude" | "ChatGPT",
  index = 1,
  fields: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  const isClaude = provider === "Claude";
  return {
    id: "da000062-0000-4000-8000-" + String(index).padStart(12, "0"),
    accountEmail: "member" + index + "@example.test",
    type: isClaude ? "claude-code-oauth-token" : "codex-oauth-token",
    framework: isClaude ? "claude-code" : "codex",
    planType: "pro",
    isActive: index === 1,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...fields,
  };
}
export function usageWindow(remaining: number, seconds: number) {
  return {
    remainingPercent: remaining,
    usedPercent: 100 - remaining,
    windowSeconds: seconds,
    resetAt: null,
  };
}
export const approvalUrl = "https://auth.example.test/approve/claude";
export function serveClaudeLogin(context: TestContext) {
  let request: { scope: string; mode?: string } | undefined;
  context.mocks.api(claude.start, ({ body, respond }) => {
    request = body;
    return respond(200, {
      sessionToken: "local-claude",
      type: "claude-code",
      status: "pending",
      scope: body.scope,
      browserUrl: approvalUrl,
      expiresIn: 900,
    });
  });
  context.mocks.api(claude.cancel, ({ respond }) => {
    return respond(200, { status: "cancelled" });
  });
  return () => {
    return request;
  };
}
export function serveCodexLogin(context: TestContext) {
  context.mocks.api(codex.start, ({ body, respond }) => {
    return respond(200, {
      sessionToken: "local-codex",
      type: "codex",
      status: "pending",
      scope: body.scope,
      browserUrl: "https://auth.example.test/approve/codex",
      verificationCode: "PLAN-8261",
      expiresIn: 900,
      interval: 1,
    });
  });
  context.mocks.api(codex.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });
  context.mocks.api(codex.cancel, ({ respond }) => {
    return respond(200, { status: "cancelled" });
  });
}

export async function providerGroup(name: string) {
  const region = await screen.findByRole("region", { name });
  return {
    ...within(region),
    button: (label: string) => {
      return getAction("button", label, region);
    },
  };
}
