import { describe, expect, it } from "vitest";

import {
  androidAntigravitySubscriptionTransforms,
  iosAntigravitySubscriptionTransforms,
} from "../antigravity-subscription";

function account(type: string, index: number) {
  return {
    id: `da000062-0000-4000-8000-00000000000${index}`,
    type,
    framework: type === "codex-oauth-token" ? "codex" : "claude-code",
    accountEmail: `member${index}@example.test`,
    isActive: true,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  };
}

function runModel(model: string, providerType: string) {
  return {
    model,
    modelLabel: model,
    modelProviderId: null,
    memberEffective: {
      providerType,
      runtimeProviderType: providerType,
      credentialScope: "member",
      availability: "available",
      accountSelection: "capture_required",
    },
  };
}

describe.each([
  ["Android", androidAntigravitySubscriptionTransforms],
  ["iOS", iosAntigravitySubscriptionTransforms],
])("installed %s builds", (_, transforms) => {
  it("hides Antigravity subscriptions and models", () => {
    const codex = account("codex-oauth-token", 1);
    expect(
      transforms.subscriptions.transform({
        subscriptions: [codex, account("antigravity", 2)],
      }),
    ).toEqual({ subscriptions: [codex] });

    const gpt = runModel("gpt-6.1-sol", "codex-oauth-token");
    expect(
      transforms.runModels.transform({
        models: [gpt, runModel("gemini-4-neon", "antigravity")],
      }),
    ).toEqual({ models: [gpt] });
  });

  it("passes other single accounts through and rejects an Antigravity one", () => {
    const claude = account("claude-code-oauth-token", 3);
    expect(transforms.activate.transform(claude)).toEqual(claude);
    const completed = { status: "complete", created: true, provider: claude };
    expect(transforms.claudeCodeComplete.transform(completed)).toEqual(
      completed,
    );
    expect(() => {
      return transforms.activate.transform(account("antigravity", 4));
    }).toThrow("Native apps cannot decode an Antigravity subscription");
  });
});
