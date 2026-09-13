import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  mockClaudeCodeTokenEndpoint,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";

const context = testContext();
const bdd = createBddApi(context);
const authDevice = createAuthDeviceApiActions(context);
const support = createAuthDeviceSupportApi(context);

interface OAuthErrorBody {
  readonly error: string;
  readonly error_description: string;
}

interface CliApprovalErrorBody {
  readonly success: false;
  readonly error: string;
}

function expectOAuthError(body: unknown): asserts body is OAuthErrorBody {
  if (
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    !("error_description" in body)
  ) {
    throw new Error("Expected OAuth error response body");
  }
}

function expectCliApprovalError(
  body: unknown,
): asserts body is CliApprovalErrorBody {
  if (
    typeof body !== "object" ||
    body === null ||
    !("success" in body) ||
    !("error" in body) ||
    body.success !== false
  ) {
    throw new Error("Expected CLI approval error response body");
  }
}

async function connectPersonalCodexTestAccount(
  actor: ApiTestUser,
  args: {
    readonly accessTokenExpiresAt: number;
    readonly accountId: string;
    readonly refreshToken: string;
    readonly workspaceName: string;
  },
): Promise<string> {
  mockCodexDeviceAuthProvider({
    tokenScope: "personal",
    ...args,
  });
  const started = await authDevice.requestCodexStart(actor, "personal", [200], {
    mode: "add",
  });
  if (started.status !== 200) {
    throw new Error(`Expected ${args.accountId} device auth to start`);
  }
  const completed = await authDevice.requestCodexComplete(
    actor,
    started.body.sessionToken,
    [200],
  );
  if (!("status" in completed.body) || completed.body.status !== "complete") {
    throw new Error(`Expected ${args.accountId} device auth to complete`);
  }
  return completed.body.provider.id;
}

describe("AUTH-02: CLI device authorization", () => {
  it("starts, polls, approves, exchanges, and uses the issued bearer through public APIs", async () => {
    const actor = bdd.user();

    const started = await authDevice.startCliDevice();
    expect(started.device_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.user_code).toBe(started.device_code);
    expect(started.verification_path).toBe("/cli-auth");
    expect(started.expires_in).toBe(900);
    expect(started.interval).toBe(5);

    const pending = await authDevice.requestCliToken(
      started.device_code,
      [202],
    );
    expectOAuthError(pending.body);
    expect(pending.body.error).toBe("authorization_pending");

    const approved = await authDevice.requestCliApproval(
      actor,
      { device_code: ` ${started.user_code.toLowerCase()} ` },
      [200],
    );
    expect(approved.body).toStrictEqual({ success: true });

    const token = await authDevice.requestCliToken(started.device_code, [200]);
    if (token.status !== 200) {
      throw new Error(
        `Expected CLI token exchange to succeed, got ${token.status}`,
      );
    }
    expect(token.body.token_type).toBe("Bearer");
    expect(token.body.access_token).toMatch(/^vm0_pat_/);

    const me = await authDevice.readMeWithBearer(
      token.body.access_token,
      actor,
      [200],
    );
    expect(me.body).toStrictEqual({
      userId: actor.userId,
      email: actor.email,
      orgId: actor.orgId,
    });

    const reused = await authDevice.requestCliToken(started.device_code, [400]);
    expectOAuthError(reused.body);
    expect(reused.body.error).toBe("invalid_request");
  });

  it("returns visible validation and auth errors for bad CLI device requests", async () => {
    const actor = bdd.user();

    const missingDeviceCode = await authDevice.requestCliToken("", [400]);
    expectOAuthError(missingDeviceCode.body);
    expect(missingDeviceCode.body.error).toBe("invalid_request");
    expect(missingDeviceCode.body.error_description).toContain(
      "device_code is required",
    );

    const unknownApproval = await authDevice.requestCliApproval(
      actor,
      { device_code: "ABCD-EFGH" },
      [400],
    );
    expectCliApprovalError(unknownApproval.body);
    expect(unknownApproval.body.error).toBe("Invalid or expired device code");

    const unauthenticatedApproval = await authDevice.requestCliApproval(
      null,
      { device_code: "ABCD-EFGH" },
      [401],
    );
    expectApiError(unauthenticatedApproval.body);
    expect(unauthenticatedApproval.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("AUTH-02: desktop auth handoff", () => {
  it("requires a session, returns a safe dev callback URL, and consumes the handoff once", async () => {
    authDevice.mockDesktopSignInToken("ticket_desktop_bdd");

    const unauthenticated = await authDevice.requestDesktopHandoff(
      null,
      {},
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    const handoff = await authDevice.requestDesktopHandoff(
      actor,
      { callbackScheme: "ai.okou.desktop.dev" },
      [200],
    );
    if (handoff.status !== 200) {
      throw new Error(
        `Expected desktop handoff to succeed, got ${handoff.status}`,
      );
    }
    const callbackUrl = new URL(handoff.body.callbackUrl);
    expect(callbackUrl.protocol).toBe("ai.okou.desktop.dev:");
    expect(callbackUrl.hostname).toBe("auth");
    expect(callbackUrl.pathname).toBe("/callback");
    expect(handoff.body.callbackUrl).not.toContain("ticket");
    expect(handoff.body.callbackUrl).not.toContain("token");
    expect(handoff.body.handoffId).not.toBe("");
    expect(authDevice.callbackHandoffId(handoff.body.callbackUrl)).toBe(
      handoff.body.handoffId,
    );

    const code = authDevice.callbackCode(handoff.body.callbackUrl);
    expect(code).not.toBe("");

    const consumed = await authDevice.requestDesktopConsume(code, [200]);
    expect(consumed.body).toStrictEqual({ token: "ticket_desktop_bdd" });

    const reused = await authDevice.requestDesktopConsume(code, [400]);
    expectApiError(reused.body);
    expect(reused.body.error.message).toBe(
      "Desktop sign-in link is invalid or expired.",
    );

    const patternInvalid = await authDevice.requestDesktopConsume(
      "bad code with spaces!",
      [400],
    );
    expectApiError(patternInvalid.body);
    expect(patternInvalid.body.error.message).toBe(
      "Desktop sign-in link is invalid or expired.",
    );

    const missingCode = await authDevice.requestDesktopConsume("", [400]);
    expectApiError(missingCode.body);
    expect(missingCode.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects a retired Zero callback scheme", async () => {
    const retired = await authDevice.requestDesktopHandoffRaw(
      bdd.user(),
      JSON.stringify({ callbackScheme: "ai.vm0.zero.desktop" }),
    );
    expect(retired.status).toBe(400);
    expectApiError(retired.body);
    expect(retired.body.error.code).toBe("BAD_REQUEST");
  });

  it("creates and consumes an Okou desktop auth callback", async () => {
    authDevice.mockDesktopSignInToken("ticket_okou_desktop_bdd");

    const handoff = await authDevice.requestDesktopHandoff(
      bdd.user(),
      { callbackScheme: "ai.okou.desktop" },
      [200],
    );
    if (handoff.status !== 200) {
      throw new Error(
        `Expected Okou desktop handoff to succeed, got ${handoff.status}`,
      );
    }

    const callbackUrl = new URL(handoff.body.callbackUrl);
    expect(callbackUrl.protocol).toBe("ai.okou.desktop:");
    expect(callbackUrl.hostname).toBe("auth");
    expect(callbackUrl.pathname).toBe("/callback");

    const code = authDevice.callbackCode(handoff.body.callbackUrl);
    const consumed = await authDevice.requestDesktopConsume(code, [200]);
    expect(consumed.body).toStrictEqual({ token: "ticket_okou_desktop_bdd" });
  });

  it("tracks handoff status through consume and complete for the creating user only", async () => {
    authDevice.mockDesktopSignInToken("ticket_desktop_status_bdd");

    const actor = bdd.user();
    const handoff = await authDevice.requestDesktopHandoff(actor, {}, [200]);
    if (handoff.status !== 200) {
      throw new Error(
        `Expected desktop handoff to succeed, got ${handoff.status}`,
      );
    }
    const handoffId = handoff.body.handoffId;

    const pending = await authDevice.requestDesktopHandoffStatus(
      actor,
      handoffId,
      [200],
    );
    expect(pending.body).toStrictEqual({ status: "pending" });

    const foreignStatus = await authDevice.requestDesktopHandoffStatus(
      bdd.user(),
      handoffId,
      [404],
    );
    expectApiError(foreignStatus.body);
    expect(foreignStatus.body.error.code).toBe("NOT_FOUND");

    const unconsumedComplete = await authDevice.requestDesktopHandoffComplete(
      actor,
      handoffId,
      [404],
    );
    expectApiError(unconsumedComplete.body);
    expect(unconsumedComplete.body.error.code).toBe("NOT_FOUND");

    const code = authDevice.callbackCode(handoff.body.callbackUrl);
    const consumed = await authDevice.requestDesktopConsume(code, [200]);
    expect(consumed.body).toStrictEqual({
      token: "ticket_desktop_status_bdd",
    });

    const consumedStatus = await authDevice.requestDesktopHandoffStatus(
      actor,
      handoffId,
      [200],
    );
    expect(consumedStatus.body).toStrictEqual({ status: "consumed" });

    const completed = await authDevice.requestDesktopHandoffComplete(
      actor,
      handoffId,
      [200],
    );
    expect(completed.body).toStrictEqual({ status: "completed" });

    const completedStatus = await authDevice.requestDesktopHandoffStatus(
      actor,
      handoffId,
      [200],
    );
    expect(completedStatus.body).toStrictEqual({ status: "completed" });
  });
});

describe("AUTH-02: platform realtime token", () => {
  it("issues user and active-org realtime tokens only for authenticated users", async () => {
    const unauthenticated = await authDevice.requestPlatformRealtimeToken(
      null,
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    const capability = JSON.stringify({
      [`user:${actor.userId}`]: ["subscribe"],
      [`org:${actor.orgId}`]: ["subscribe"],
      [`user-org:${actor.userId}:${actor.orgId}`]: ["subscribe"],
    });
    context.mocks.ably.createTokenRequest.mockResolvedValueOnce({
      keyName: "ably-key",
      timestamp: now(),
      capability,
      clientId: actor.userId,
      nonce: "nonce",
      mac: "mac",
    });

    const token = await authDevice.requestPlatformRealtimeToken(actor, [200]);
    if (token.status !== 200) {
      throw new Error("Expected platform realtime token request to succeed");
    }
    expect(token.body.capability).toBe(capability);
    expect(token.body.clientId).toBe(actor.userId);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: {
        [`user:${actor.userId}`]: ["subscribe"],
        [`org:${actor.orgId}`]: ["subscribe"],
        [`user-org:${actor.userId}:${actor.orgId}`]: ["subscribe"],
      },
      ttl: 60 * 60 * 1000,
      clientId: actor.userId,
    });
  });

  it("keeps user realtime available without an active organization", async () => {
    const actor = bdd.user({ orgId: null });
    const capability = JSON.stringify({
      [`user:${actor.userId}`]: ["subscribe"],
    });
    context.mocks.ably.createTokenRequest.mockResolvedValueOnce({
      keyName: "ably-key",
      timestamp: now(),
      capability,
      clientId: actor.userId,
      nonce: "nonce",
      mac: "mac",
    });

    const token = await authDevice.requestPlatformRealtimeToken(actor, [200]);
    if (token.status !== 200) {
      throw new Error("Expected platform realtime token request to succeed");
    }
    expect(token.body.capability).toBe(capability);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: {
        [`user:${actor.userId}`]: ["subscribe"],
      },
      ttl: 60 * 60 * 1000,
      clientId: actor.userId,
    });
  });
});

describe("MODEL-PROVIDER: device auth boundaries", () => {
  it("starts, polls, and cancels a Codex device auth session through public APIs", async () => {
    let userCodeRequests = 0;
    let tokenPollRequests = 0;
    server.use(
      http.post(
        "https://auth.openai.com/api/accounts/deviceauth/usercode",
        async ({ request }) => {
          userCodeRequests += 1;
          const body: unknown = await request.json();
          expect(body).toMatchObject({
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          });
          return HttpResponse.json({
            device_auth_id: "device-auth-bdd",
            user_code: "CODEX-BDD",
            interval: 7,
          });
        },
      ),
      http.post(
        "https://auth.openai.com/api/accounts/deviceauth/token",
        async ({ request }) => {
          tokenPollRequests += 1;
          const body: unknown = await request.json();
          expect(body).toStrictEqual({
            device_auth_id: "device-auth-bdd",
            user_code: "CODEX-BDD",
          });
          return HttpResponse.text("authorization pending", { status: 403 });
        },
      ),
    );

    const admin = bdd.user();
    const started = await authDevice.requestCodexStart(
      admin,
      "personal",
      [200],
    );
    if (started.status !== 200) {
      throw new Error(
        `Expected Codex device auth start, got ${started.status}`,
      );
    }
    expect(started.body).toMatchObject({
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "CODEX-BDD",
      interval: 7,
    });
    expect(started.body.sessionToken).toStrictEqual(expect.any(String));
    expect(userCodeRequests).toBe(1);

    const pending = await authDevice.requestCodexComplete(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(pending.body).toStrictEqual({
      status: "pending",
      errorMessage: null,
    });
    expect(tokenPollRequests).toBe(1);

    const otherUser = bdd.user({ orgId: admin.orgId });
    const crossUserCancel = await authDevice.requestCodexCancel(
      otherUser,
      started.body.sessionToken,
      [404],
    );
    expectApiError(crossUserCancel.body);
    expect(crossUserCancel.body.error.code).toBe("NOT_FOUND");

    const cancelled = await authDevice.requestCodexCancel(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(cancelled.body).toStrictEqual({ status: "cancelled" });

    const afterCancel = await authDevice.requestCodexComplete(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(afterCancel.body).toStrictEqual({
      status: "pending",
      errorMessage: "Codex device auth session was cancelled",
    });
  });

  it("starts and cancels a Claude Code device auth session through public APIs", async () => {
    const admin = bdd.user();

    const started = await authDevice.requestClaudeCodeStart(
      admin,
      "personal",
      [200],
    );
    if (started.status !== 200) {
      throw new Error(
        `Expected Claude Code device auth start, got ${started.status}`,
      );
    }
    expect(started.body).toMatchObject({
      type: "claude-code",
      status: "pending",
      scope: "personal",
      expiresIn: expect.any(Number),
    });
    expect(started.body.sessionToken).toStrictEqual(expect.any(String));
    const browserUrl = new URL(started.body.browserUrl);
    expect(browserUrl.origin).toBe("https://claude.com");
    expect(browserUrl.pathname).toBe("/cai/oauth/authorize");
    expect(browserUrl.searchParams.get("response_type")).toBe("code");
    expect(browserUrl.searchParams.get("scope")).toBe(
      "user:profile user:inference",
    );

    const wrongState = await authDevice.requestClaudeCodeComplete(
      admin,
      started.body.sessionToken,
      "claude-code-bdd#wrong-state",
      [400],
    );
    expectApiError(wrongState.body);
    expect(wrongState.body.error.message).toBe(
      "Claude Code authorization code belongs to another session",
    );

    const otherUser = bdd.user({ orgId: admin.orgId });
    const crossUserCancel = await authDevice.requestClaudeCodeCancel(
      otherUser,
      started.body.sessionToken,
      [404],
    );
    expectApiError(crossUserCancel.body);
    expect(crossUserCancel.body.error.code).toBe("NOT_FOUND");

    const cancelled = await authDevice.requestClaudeCodeCancel(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(cancelled.body).toStrictEqual({ status: "cancelled" });

    const afterCancel = await authDevice.requestClaudeCodeComplete(
      admin,
      started.body.sessionToken,
      "claude-code-bdd",
      [400],
    );
    expectApiError(afterCancel.body);
    expect(afterCancel.body.error.message).toBe(
      "Claude Code device auth session is not ready",
    );
  });

  it("completes org-scope Codex device auth and exposes the imported provider", async () => {
    const calls = mockCodexDeviceAuthProvider({ tokenScope: "org" });
    const admin = bdd.user();

    const started = await authDevice.requestCodexStart(admin, "org", [200]);
    if (started.status !== 200) {
      throw new Error(
        `Expected Codex device auth start, got ${started.status}`,
      );
    }
    expect(started.body).toMatchObject({
      type: "codex",
      status: "pending",
      scope: "org",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      interval: 5,
    });
    expect(calls.userCode).toStrictEqual([
      { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" },
    ]);

    const completed = await authDevice.requestCodexComplete(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      created: true,
      provider: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        workspaceName: "Org Acme",
        planType: "plus",
      },
    });
    expect(calls.deviceToken).toStrictEqual([
      { device_auth_id: "device_auth_test", user_code: "ABCD-EFGH" },
    ]);
    expect(calls.oauthToken).toHaveLength(1);
    const oauthTokenBody = calls.oauthToken[0];
    expect(oauthTokenBody?.get("grant_type")).toBe("authorization_code");
    expect(oauthTokenBody?.get("code")).toBe("auth_code_test");
    expect(oauthTokenBody?.get("redirect_uri")).toBe(
      "https://auth.openai.com/deviceauth/callback",
    );
    expect(oauthTokenBody?.get("client_id")).toBe(
      "app_EMoamEEZ73f0CkXaXp7hrann",
    );
    expect(oauthTokenBody?.get("code_verifier")).toBe("code_verifier_test");

    const providers = await support.listModelProviders(admin);
    expect(
      providers.body.modelProviders.find((provider) => {
        return provider.type === "codex-oauth-token";
      }),
    ).toMatchObject({ workspaceName: "Org Acme", planType: "plus" });

    const reComplete = await authDevice.requestCodexComplete(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(reComplete.body).toStrictEqual({
      status: "pending",
      errorMessage: null,
    });
    expect(calls.deviceToken).toHaveLength(1);

    await authDevice.deleteOrgModelProvider(admin, "codex-oauth-token");
  });

  it("completes personal-scope Codex device auth for an org member", async () => {
    const calls = mockCodexDeviceAuthProvider({ tokenScope: "personal" });
    const member = bdd.user({ orgRole: "org:member" });

    const started = await authDevice.requestCodexStart(
      member,
      "personal",
      [200],
    );
    if (started.status !== 200) {
      throw new Error(
        `Expected Codex device auth start, got ${started.status}`,
      );
    }

    const completed = await authDevice.requestCodexComplete(
      member,
      started.body.sessionToken,
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      provider: {
        type: "codex-oauth-token",
        workspaceName: "Personal Acme",
      },
    });
    expect(calls.deviceToken).toHaveLength(1);

    const personalProviders = await support.listPersonalModelProviders(
      member,
      [200],
    );
    if (!("modelProviders" in personalProviders.body)) {
      throw new Error("Expected personal model provider list response");
    }
    expect(
      personalProviders.body.modelProviders.some((provider) => {
        return provider.type === "codex-oauth-token";
      }),
    ).toBeTruthy();

    await support.deletePersonalModelProvider(
      member,
      "codex-oauth-token",
      [204],
    );
  });

  it("adds, switches, reconnects, deduplicates, and deletes concrete Codex accounts", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    await support.updateFeatureSwitches(member, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    });

    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "codex-account-a",
      workspaceName: "Account A",
    });
    const startedA = await authDevice.requestCodexStart(
      member,
      "personal",
      [200],
      { mode: "add" },
    );
    if (startedA.status !== 200) {
      throw new Error("Expected account A device auth to start");
    }
    const completedA = await authDevice.requestCodexComplete(
      member,
      startedA.body.sessionToken,
      [200],
    );
    if (
      !("status" in completedA.body) ||
      completedA.body.status !== "complete" ||
      !completedA.body.provider.isActive
    ) {
      throw new Error("Expected account A to be the first active account");
    }
    const accountAId = completedA.body.provider.id;

    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "codex-account-b",
      workspaceName: "Account B",
    });
    const startedB = await authDevice.requestCodexStart(
      member,
      "personal",
      [200],
      { mode: "add" },
    );
    if (startedB.status !== 200) {
      throw new Error("Expected account B device auth to start");
    }
    const completedB = await authDevice.requestCodexComplete(
      member,
      startedB.body.sessionToken,
      [200],
    );
    if (
      !("status" in completedB.body) ||
      completedB.body.status !== "complete"
    ) {
      throw new Error("Expected account B device auth to complete");
    }
    const accountBId = completedB.body.provider.id;
    expect(completedB.body.provider.isActive).toBeFalsy();

    await support.activatePersonalModelProviderAccount(member, accountBId);

    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "codex-account-b",
      workspaceName: "Account B reconnected",
    });
    const reconnectA = await authDevice.requestCodexStart(
      member,
      "personal",
      [200],
      { mode: "reconnect", modelProviderId: accountAId },
    );
    if (reconnectA.status !== 200) {
      throw new Error("Expected account A reconnect to start");
    }
    await authDevice.requestCodexComplete(
      member,
      reconnectA.body.sessionToken,
      [200],
    );

    const deduplicated = await support.listPersonalModelProviders(
      member,
      [200],
    );
    if (!("modelProviders" in deduplicated.body)) {
      throw new Error("Expected personal model provider list response");
    }
    expect(deduplicated.body.modelProviders).toHaveLength(1);
    expect(deduplicated.body.modelProviders[0]).toMatchObject({
      id: accountAId,
      isActive: true,
      workspaceName: "Account B reconnected",
    });

    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "codex-account-c",
      workspaceName: "Account C",
    });
    const startedC = await authDevice.requestCodexStart(
      member,
      "personal",
      [200],
      { mode: "add" },
    );
    if (startedC.status !== 200) {
      throw new Error("Expected account C device auth to start");
    }
    const completedC = await authDevice.requestCodexComplete(
      member,
      startedC.body.sessionToken,
      [200],
    );
    if (
      !("status" in completedC.body) ||
      completedC.body.status !== "complete"
    ) {
      throw new Error("Expected account C device auth to complete");
    }

    await support.deletePersonalModelProviderAccount(member, accountAId);
    const afterActiveDelete = await support.listPersonalModelProviders(
      member,
      [200],
    );
    if (!("modelProviders" in afterActiveDelete.body)) {
      throw new Error("Expected personal model provider list response");
    }
    expect(afterActiveDelete.body.modelProviders).toHaveLength(1);
    expect(afterActiveDelete.body.modelProviders[0]).toMatchObject({
      id: completedC.body.provider.id,
      isActive: true,
    });

    await support.deletePersonalModelProvider(
      member,
      "codex-oauth-token",
      [204],
    );
  });

  it("refreshes and resets the requested inactive Codex account", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    await support.updateFeatureSwitches(member, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    });
    const currentSeconds = Math.floor(now() / 1000);
    const requestedAccountId = await connectPersonalCodexTestAccount(member, {
      accessTokenExpiresAt: currentSeconds - 60,
      accountId: "codex-reset-requested-account",
      refreshToken: "rt_codex_reset_requested_account",
      workspaceName: "Reset Requested Account",
    });
    const activeAccountId = await connectPersonalCodexTestAccount(member, {
      accessTokenExpiresAt: currentSeconds + 7200,
      accountId: "codex-reset-active-account",
      refreshToken: "rt_codex_reset_active_account",
      workspaceName: "Reset Active Account",
    });
    await support.activatePersonalModelProviderAccount(member, activeAccountId);

    const idempotencyKey = randomUUID();
    const refreshedAccessToken = "fresh-requested-reset-access-token";
    let refreshCalls = 0;
    let consumeCalls = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
        refreshCalls += 1;
        await expect(request.json()).resolves.toMatchObject({
          grant_type: "refresh_token",
          refresh_token: "rt_codex_reset_requested_account",
        });
        return HttpResponse.json({
          access_token: refreshedAccessToken,
          refresh_token: "rotated-requested-reset-refresh-token",
          expires_in: 3600,
        });
      }),
      http.post(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        async ({ request }) => {
          consumeCalls += 1;
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${refreshedAccessToken}`,
          );
          expect(request.headers.get("chatgpt-account-id")).toBe(
            "codex-reset-requested-account",
          );
          await expect(request.json()).resolves.toStrictEqual({
            redeem_request_id: idempotencyKey,
          });
          return HttpResponse.json({ code: "reset", windows_reset: 2 });
        },
      ),
    );

    const reset = await support.resetPersonalModelProviderAccount(
      member,
      requestedAccountId,
      idempotencyKey,
      [200],
    );
    expect(reset.body).toStrictEqual({ outcome: "reset" });
    expect(refreshCalls).toBe(1);
    expect(consumeCalls).toBe(1);

    await support.deletePersonalModelProvider(
      member,
      "codex-oauth-token",
      [204],
    );
  });

  it("isolates terminal Codex refresh state between concrete accounts", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    await support.updateFeatureSwitches(member, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    });
    const currentSeconds = Math.floor(now() / 1000);
    const accountAId = await connectPersonalCodexTestAccount(member, {
      accessTokenExpiresAt: currentSeconds - 60,
      accountId: "codex-refresh-account-a",
      refreshToken: "rt_codex_refresh_account_a",
      workspaceName: "Refresh Account A",
    });
    const accountBId = await connectPersonalCodexTestAccount(member, {
      accessTokenExpiresAt: currentSeconds + 7200,
      accountId: "codex-refresh-account-b",
      refreshToken: "rt_codex_refresh_account_b",
      workspaceName: "Refresh Account B",
    });

    let refreshCalls = 0;
    const usageAccountIds: (string | null)[] = [];
    server.use(
      http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
        refreshCalls += 1;
        await expect(request.json()).resolves.toMatchObject({
          grant_type: "refresh_token",
          refresh_token: "rt_codex_refresh_account_a",
        });
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_invalidated",
              message: "refresh token invalidated",
            },
          },
          { status: 401 },
        );
      }),
      http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
        const accountId = request.headers.get("chatgpt-account-id");
        usageAccountIds.push(accountId);
        expect(accountId).toBe("codex-refresh-account-b");
        return HttpResponse.json({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              limit_window_seconds: 18_000,
              reset_at: 1_893_441_600,
              used_percent: 20,
            },
          },
        });
      }),
    );

    for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
      const listed = await support.listPersonalModelProviders(member, [200]);
      if (!("modelProviders" in listed.body)) {
        throw new Error("Expected personal model provider list response");
      }
      expect(
        listed.body.modelProviders.find((provider) => {
          return provider.id === accountAId;
        }),
      ).toMatchObject({
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_token_invalidated",
      });
      expect(
        listed.body.modelProviders.find((provider) => {
          return provider.id === accountBId;
        }),
      ).toMatchObject({
        needsReconnect: false,
        subscriptionUsage: {
          fiveHour: { usedPercent: 20 },
        },
      });
    }

    expect(refreshCalls).toBe(1);
    expect(usageAccountIds).toStrictEqual([
      "codex-refresh-account-b",
      "codex-refresh-account-b",
    ]);
    await support.deletePersonalModelProvider(
      member,
      "codex-oauth-token",
      [204],
    );
  });

  it("adds, switches, and deduplicates concrete Claude Code accounts by email and workspace", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    await support.updateFeatureSwitches(member, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    });

    const completeClaudeAccount = async (mutation: {
      readonly mode: "add" | "reconnect";
      readonly modelProviderId?: string;
    }) => {
      const started = await authDevice.requestClaudeCodeStart(
        member,
        "personal",
        [200],
        mutation,
      );
      if (started.status !== 200) {
        throw new Error("Expected Claude Code device auth to start");
      }
      const state = new URL(started.body.browserUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Missing state in Claude Code browser URL");
      }
      const completed = await authDevice.requestClaudeCodeComplete(
        member,
        started.body.sessionToken,
        `claude_code_test#${state}`,
        [200],
      );
      if (completed.status !== 200) {
        throw new Error("Expected Claude Code device auth to complete");
      }
      return completed.body;
    };

    mockClaudeCodeTokenEndpoint({
      accountEmail: "first@example.com",
      organizationName: "First Workspace",
    });
    const first = await completeClaudeAccount({ mode: "add" });
    expect(first.provider.isActive).toBeTruthy();
    const firstAccountId = first.provider.id;

    // A different email is a different identity, so it is added rather than
    // deduplicated onto the first account.
    mockClaudeCodeTokenEndpoint({
      accountEmail: "second@example.com",
      organizationName: "Second Workspace",
    });
    const second = await completeClaudeAccount({ mode: "add" });
    expect(second.provider.isActive).toBeFalsy();
    const secondAccountId = second.provider.id;
    expect(secondAccountId).not.toBe(firstAccountId);

    await support.activatePersonalModelProviderAccount(member, secondAccountId);

    const bothConnected = await support.listPersonalModelProviders(
      member,
      [200],
    );
    if (!("modelProviders" in bothConnected.body)) {
      throw new Error("Expected personal model provider list response");
    }
    expect(bothConnected.body.modelProviders).toHaveLength(2);
    expect(bothConnected.body.modelProviders[0]).toMatchObject({
      id: secondAccountId,
      isActive: true,
      accountEmail: "second@example.com",
      workspaceName: "Second Workspace",
    });

    // Re-adding the same email and workspace matches the existing identity and
    // updates it in place instead of creating a third account.
    mockClaudeCodeTokenEndpoint({
      accountEmail: "FIRST@example.com",
      organizationName: "First Workspace",
    });
    const readded = await completeClaudeAccount({ mode: "add" });
    expect(readded.provider.id).toBe(firstAccountId);
    expect(readded.created).toBeFalsy();

    const afterDedup = await support.listPersonalModelProviders(member, [200]);
    if (!("modelProviders" in afterDedup.body)) {
      throw new Error("Expected personal model provider list response");
    }
    expect(afterDedup.body.modelProviders).toHaveLength(2);
    expect(
      afterDedup.body.modelProviders.find((provider) => {
        return provider.id === firstAccountId;
      }),
    ).toMatchObject({
      accountEmail: "first@example.com",
      workspaceName: "First Workspace",
      isActive: false,
    });

    await support.deletePersonalModelProvider(
      member,
      "claude-code-oauth-token",
      [204],
    );
  });

  it("returns bad requests after the tenth personal subscription account", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    await support.updateFeatureSwitches(member, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    });

    const completeCodexAccount = async (
      index: number,
      statuses: readonly (200 | 400)[],
    ) => {
      mockCodexDeviceAuthProvider({
        tokenScope: "personal",
        accountId: `codex-limit-account-${index}`,
        workspaceName: `Codex Account ${index}`,
      });
      const started = await authDevice.requestCodexStart(
        member,
        "personal",
        [200],
        { mode: "add" },
      );
      if (started.status !== 200) {
        throw new Error("Expected Codex device auth to start");
      }
      return await authDevice.requestCodexComplete(
        member,
        started.body.sessionToken,
        statuses,
      );
    };

    for (let index = 0; index < 10; index += 1) {
      await completeCodexAccount(index, [200]);
    }
    const codexLimit = await completeCodexAccount(10, [400]);
    if (codexLimit.status !== 400) {
      throw new Error("Expected Codex account limit to return bad request");
    }
    expectApiError(codexLimit.body);
    expect(codexLimit.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "A maximum of 10 codex-oauth-token accounts can be connected",
    });

    const completeClaudeCodeAccount = async (
      index: number,
      statuses: readonly (200 | 400)[],
    ) => {
      mockClaudeCodeTokenEndpoint({
        accountEmail: `claude-limit-${index}@example.com`,
        organizationName: `Claude Account ${index}`,
      });
      const started = await authDevice.requestClaudeCodeStart(
        member,
        "personal",
        [200],
        { mode: "add" },
      );
      if (started.status !== 200) {
        throw new Error("Expected Claude Code device auth to start");
      }
      const state = new URL(started.body.browserUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Missing state in Claude Code browser URL");
      }
      return await authDevice.requestClaudeCodeComplete(
        member,
        started.body.sessionToken,
        `claude_code_test#${state}`,
        statuses,
      );
    };

    for (let index = 0; index < 10; index += 1) {
      await completeClaudeCodeAccount(index, [200]);
    }
    const claudeCodeLimit = await completeClaudeCodeAccount(10, [400]);
    if (claudeCodeLimit.status !== 400) {
      throw new Error(
        "Expected Claude Code account limit to return bad request",
      );
    }
    expectApiError(claudeCodeLimit.body);
    expect(claudeCodeLimit.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message:
        "A maximum of 10 claude-code-oauth-token accounts can be connected",
    });

    await support.deletePersonalModelProvider(
      member,
      "codex-oauth-token",
      [204],
    );
    await support.deletePersonalModelProvider(
      member,
      "claude-code-oauth-token",
      [204],
    );
  });

  it("completes org-scope Claude Code device auth with a pasted code fragment", async () => {
    const calls = mockClaudeCodeTokenEndpoint();
    const admin = bdd.user();

    const started = await authDevice.requestClaudeCodeStart(
      admin,
      "org",
      [200],
    );
    if (started.status !== 200) {
      throw new Error(
        `Expected Claude Code device auth start, got ${started.status}`,
      );
    }
    const browserUrl = new URL(started.body.browserUrl);
    expect(browserUrl.searchParams.get("scope")).toBe(
      "user:profile user:inference",
    );
    const state = browserUrl.searchParams.get("state");
    if (!state) {
      throw new Error("Missing state in Claude Code browser URL");
    }

    const completed = await authDevice.requestClaudeCodeComplete(
      admin,
      started.body.sessionToken,
      `auth_code_test#${state}`,
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      created: true,
      provider: {
        type: "claude-code-oauth-token",
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
        workspaceName: "Claude User's Organization",
        planType: "pro",
        subscriptionResetPeriod: "weekly",
        subscriptionNextResetAt: "2030-01-07T00:00:00.000Z",
      },
    });
    expect(calls.token).toHaveLength(1);
    expect(calls.profile).toHaveLength(1);
    expect(calls.usage).toHaveLength(1);
    expect(calls.profile[0]?.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(calls.usage[0]?.get("user-agent")).toBe("claude-code/2.1.161");
    expect(calls.token[0]).toMatchObject({
      grant_type: "authorization_code",
      code: "auth_code_test",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      state,
      expires_in: 31_536_000,
      code_verifier: expect.any(String),
    });

    const providers = await support.listModelProviders(admin);
    expect(
      providers.body.modelProviders.find((provider) => {
        return provider.type === "claude-code-oauth-token";
      }),
    ).toMatchObject({
      workspaceName: "Claude User's Organization",
      planType: "pro",
    });

    const reComplete = await authDevice.requestClaudeCodeComplete(
      admin,
      started.body.sessionToken,
      `auth_code_test#${state}`,
      [400],
    );
    expectApiError(reComplete.body);
    expect(reComplete.body.error.message).toBe(
      "Claude Code device auth session is not ready",
    );

    await authDevice.deleteOrgModelProvider(admin, "claude-code-oauth-token");
  });

  it("completes personal-scope Claude Code device auth from a full callback URL", async () => {
    mockClaudeCodeTokenEndpoint();
    const member = bdd.user({ orgRole: "org:member" });

    const started = await authDevice.requestClaudeCodeStart(
      member,
      "personal",
      [200],
    );
    if (started.status !== 200) {
      throw new Error(
        `Expected Claude Code device auth start, got ${started.status}`,
      );
    }
    const state = new URL(started.body.browserUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Missing state in Claude Code browser URL");
    }

    const completed = await authDevice.requestClaudeCodeComplete(
      member,
      started.body.sessionToken,
      `https://platform.claude.com/oauth/code/callback?code=member_code&state=${state}`,
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      provider: {
        type: "claude-code-oauth-token",
        workspaceName: "Claude User's Organization",
        planType: "pro",
      },
    });

    const personalProviders = await support.listPersonalModelProviders(
      member,
      [200],
    );
    if (!("modelProviders" in personalProviders.body)) {
      throw new Error("Expected personal model provider list response");
    }
    expect(
      personalProviders.body.modelProviders.find((provider) => {
        return provider.type === "claude-code-oauth-token";
      }),
    ).toMatchObject({
      workspaceName: "Claude User's Organization",
      planType: "pro",
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 12,
          remainingPercent: 88,
          resetAt: "2030-01-01T05:00:00.000Z",
          windowSeconds: 18_000,
        },
        weekly: {
          usedPercent: 24,
          remainingPercent: 76,
          resetAt: "2030-01-07T00:00:00.000Z",
          windowSeconds: 604_800,
        },
      },
    });

    await support.deletePersonalModelProvider(
      member,
      "claude-code-oauth-token",
      [204],
    );
  });

  it("enforces authentication, active organization, and admin scope boundaries", async () => {
    const noOrg = bdd.user({ orgId: null });
    const member = bdd.user({ orgRole: "org:member" });

    const codexUnauthenticated = await authDevice.requestCodexStart(
      null,
      "org",
      [401],
    );
    expectApiError(codexUnauthenticated.body);
    expect(codexUnauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const codexNoOrg = await authDevice.requestCodexStart(noOrg, "org", [401]);
    expectApiError(codexNoOrg.body);
    expect(codexNoOrg.body.error.code).toBe("UNAUTHORIZED");

    const codexMemberOrg = await authDevice.requestCodexStart(
      member,
      "org",
      [403],
    );
    expectApiError(codexMemberOrg.body);
    expect(codexMemberOrg.body.error.code).toBe("FORBIDDEN");

    const claudeNoOrg = await authDevice.requestClaudeCodeStart(
      noOrg,
      "org",
      [401],
    );
    expectApiError(claudeNoOrg.body);
    expect(claudeNoOrg.body.error.code).toBe("UNAUTHORIZED");

    const claudeMemberOrg = await authDevice.requestClaudeCodeStart(
      member,
      "org",
      [403],
    );
    expectApiError(claudeMemberOrg.body);
    expect(claudeMemberOrg.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects invalid model-provider device session tokens without importing provider state", async () => {
    const admin = bdd.user();

    const codexComplete = await authDevice.requestCodexComplete(
      admin,
      "not-a-session-token",
      [400],
    );
    expectApiError(codexComplete.body);
    expect(codexComplete.body.error.message).toBe(
      "Invalid Codex device auth session token",
    );

    const codexCancel = await authDevice.requestCodexCancel(
      admin,
      "not-a-session-token",
      [400],
    );
    expectApiError(codexCancel.body);
    expect(codexCancel.body.error.message).toBe(
      "Invalid Codex device auth session token",
    );

    const claudeComplete = await authDevice.requestClaudeCodeComplete(
      admin,
      "not-a-session-token",
      "authorization-code#state",
      [400],
    );
    expectApiError(claudeComplete.body);
    expect(claudeComplete.body.error.message).toBe(
      "Invalid Claude Code device auth session token",
    );

    const claudeCancel = await authDevice.requestClaudeCodeCancel(
      admin,
      "not-a-session-token",
      [400],
    );
    expectApiError(claudeCancel.body);
    expect(claudeCancel.body.error.message).toBe(
      "Invalid Claude Code device auth session token",
    );
  });
});
