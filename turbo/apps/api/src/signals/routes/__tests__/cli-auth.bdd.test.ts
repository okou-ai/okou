import { randomUUID } from "node:crypto";

import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  makeCodexAuthJson,
} from "./helpers/api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const api = createAuthDeviceApiActions(context);
const support = createAuthDeviceSupportApi(context);

function newMember(): ApiTestUser {
  const userId = `user_${randomUUID()}`;
  return {
    userId,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin",
    email: `${userId}@example.test`,
  };
}

async function approveCode(
  member: ApiTestUser,
  timezone?: string,
): Promise<void> {
  const device = await api.startCliDevice();
  const approved = await api.requestCliApproval(
    member,
    { device_code: device.device_code, ...(timezone ? { timezone } : {}) },
    [200],
  );
  expect(approved.body).toStrictEqual({ success: true });
}

async function issueDeviceToken(member: ApiTestUser) {
  const device = await api.startCliDevice();
  await api.requestCliApproval(
    member,
    { device_code: device.device_code },
    [200],
  );
  const issued = await api.requestCliToken(device.device_code, [200]);
  if (issued.status !== 200) {
    throw new Error("Expected an issued CLI token");
  }
  return issued.body;
}

function codexProviders(member: ApiTestUser) {
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  return setupApp({
    context,
    routes: [...meModelProvidersUpsertRoutes, ...meModelProvidersListRoutes],
  })(personalModelProvidersMainContract);
}

const headers = Object.freeze({ authorization: "Bearer clerk-session" });

describe("AUTH-02: CLI device authorization", () => {
  it("cli-auth.bdd-001 expires unexchanged device codes for polling and approval", async () => {
    const member = newMember();
    const first = await api.startCliDevice();
    const second = await api.startCliDevice();
    expect(first.device_code).not.toBe(second.device_code);

    mockNow(now() + 16 * 60 * 1000);
    const poll = await api.requestCliToken(first.device_code, [400]);
    expect(poll.body).toMatchObject({
      error: "expired_token",
      error_description: "The device code has expired",
    });
    const approval = await api.requestCliApproval(
      member,
      { device_code: second.device_code },
      [400],
    );
    expect(approval.body).toStrictEqual({
      success: false,
      error: "Device code has expired",
    });
  });

  it("cli-auth.bdd-002 approves a code once and sets only a valid first timezone", async () => {
    const member = newMember();
    const device = await api.startCliDevice();
    const approved = await api.requestCliApproval(
      member,
      { device_code: device.device_code },
      [200],
    );
    expect(approved.body).toStrictEqual({ success: true });
    const repeated = await api.requestCliApproval(
      member,
      { device_code: device.device_code },
      [400],
    );
    expect(repeated.body).toStrictEqual({
      success: false,
      error: "Invalid or expired device code",
    });

    await approveCode(member, "America/Los_Angeles");
    const uninitialized = await support.readUninitializedPreferences(member);
    expect(uninitialized.body).toMatchObject({
      error: { code: "USER_PREFERENCES_UNINITIALIZED" },
    });
    await support.initializePreferences(member);
    await expect(support.readPreferences(member)).resolves.toMatchObject({
      body: { timezone: "America/Los_Angeles", locale: "en-US" },
    });

    await approveCode(member, "Asia/Tokyo");
    await expect(support.readPreferences(member)).resolves.toMatchObject({
      body: { timezone: "America/Los_Angeles" },
    });

    const fresh = newMember();
    await approveCode(fresh, "Not/AZone");
    const freshPreferences = await support.readUninitializedPreferences(fresh);
    expect(freshPreferences.body).toMatchObject({
      error: { code: "USER_PREFERENCES_UNINITIALIZED" },
    });
  });

  it("cli-auth.bdd-005 signs the CLI in as a Pro member with a device-approved token", async () => {
    const bdd = createBddApi(context);
    const member = bdd.user();
    await bdd.provisionWorkspace(member);
    await publicPlanLifecycle(context, member, "pro").update("active");

    const issued = await issueDeviceToken(member);
    expect(issued.access_token).toMatch(/^vm0_pat_/);
    expect(issued.token_type).toBe("Bearer");
    expect(issued.expires_in).toBe(90 * 24 * 60 * 60);

    const me = await api.readMeWithBearer(issued.access_token, member, [200]);
    expect(me.body).toStrictEqual({
      userId: member.userId,
      email: member.email,
      orgId: member.orgId,
    });
    await expect(api.readBillingStatus(member)).resolves.toMatchObject({
      tier: "pro",
    });
  });
});

describe("Codex auth.json through the personal model-provider API", () => {
  it("cli-auth.bdd-007 reads pasted Codex metadata and rejects invalid and free-plan files", async () => {
    const member = newMember();
    const providers = codexProviders(member);
    const paste = (authJson: string) => {
      return providers.upsert({
        headers,
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: authJson },
        },
      });
    };
    const readCodex = async () => {
      const listed = await accept(providers.list({ headers }), [200]);
      return listed.body.modelProviders.find((provider) => {
        return provider.type === "codex-oauth-token";
      });
    };

    await accept(paste(makeCodexAuthJson()), [201]);
    await expect(readCodex()).resolves.toMatchObject({
      workspaceName: "Acme",
      planType: "plus",
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });

    await accept(
      paste(
        makeCodexAuthJson({
          workspaceName: "Acme Updated",
          planType: "business",
        }),
      ),
      [200],
    );
    await expect(readCodex()).resolves.toMatchObject({
      workspaceName: "Acme Updated",
      planType: "business",
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });

    const invalid = await accept(paste("{not json"), [400]);
    expect(invalid.body.error).toMatchObject({
      code: "CODEX_AUTH_JSON_SHAPE_INVALID",
      message: "auth.json is not valid JSON",
    });
    const free = await accept(
      paste(makeCodexAuthJson({ planType: "free" })),
      [400],
    );
    expect(free.body.error).toMatchObject({
      code: "CODEX_FREE_PLAN_REJECTED",
      message:
        "ChatGPT free plan is not supported — upgrade to Plus or higher.",
    });
  });
});
