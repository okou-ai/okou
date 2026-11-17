import { randomUUID } from "node:crypto";
import type { TestContext } from "../../../../__tests__/test-context";
import type { ApiTestUser } from "./api-bdd";
import {
  createAuthDeviceApiActions,
  mockClaudeCodeTokenEndpoint,
  mockCodexDeviceAuthProvider,
} from "./api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./api-bdd-auth-device-support";

/** Add through provider authentication; switching uses the same endpoint as Settings and CLI. */
export async function addRecoverySubscription(
  context: TestContext,
  actor: ApiTestUser,
  type:
    "claude-code-oauth-token" | "codex-oauth-token" = "claude-code-oauth-token",
) {
  if (type === "claude-code-oauth-token") {
    mockClaudeCodeTokenEndpoint({
      accountEmail: `recovery-${randomUUID()}@example.com`,
    });
    const device = createAuthDeviceApiActions(context);
    const started = await device.requestClaudeCodeStart(
      actor,
      "personal",
      [200],
      { mode: "add" },
    );
    if (started.status !== 200) {
      throw new Error("Expected Claude authentication");
    }
    const state = new URL(started.body.browserUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Claude authorization state");
    }
    const completed = await device.requestClaudeCodeComplete(
      actor,
      started.body.sessionToken,
      `claude_code_test#${state}`,
      [200],
    );
    if (completed.status !== 200) {
      throw new Error("Expected a connected Claude subscription");
    }
    return completed.body.provider.id;
  }
  mockCodexDeviceAuthProvider({ accountId: `recovery-${randomUUID()}` });
  const device = createAuthDeviceApiActions(context);
  const started = await device.requestCodexStart(actor, "personal", [200], {
    mode: "add",
  });
  if (started.status !== 200) {
    throw new Error("Expected subscription authentication");
  }
  const completed = await device.requestCodexComplete(
    actor,
    started.body.sessionToken,
    [200],
  );
  if (!("status" in completed.body) || completed.body.status !== "complete") {
    throw new Error("Expected subscription authentication to finish");
  }
  return completed.body.provider.id;
}

export async function switchRecoverySubscription(
  context: TestContext,
  actor: ApiTestUser,
  type:
    "claude-code-oauth-token" | "codex-oauth-token" = "claude-code-oauth-token",
) {
  const id = await addRecoverySubscription(context, actor, type);
  await createAuthDeviceSupportApi(
    context,
  ).activatePersonalModelProviderAccount(actor, id);
  return id;
}
