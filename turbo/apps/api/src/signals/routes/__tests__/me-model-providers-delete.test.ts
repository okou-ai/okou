import { randomUUID } from "node:crypto";

import {
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({
  context,
  routes: [
    ...meModelProvidersDeleteRoutes,
    ...meModelProvidersListRoutes,
    ...meModelProvidersUpsertRoutes,
  ],
});
const providers = app(personalModelProvidersMainContract);
const providersByType = app(personalModelProvidersByTypeContract);

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function member(orgId = `org_${randomUUID()}`): Member {
  return { userId: `user_${randomUUID()}`, orgId };
}

function signIn(actor: Member): void {
  mocks.clerk.session(actor.userId, actor.orgId);
}

function claudeProfile(profile: () => Response): void {
  server.use(
    http.get("https://api.anthropic.com/api/oauth/profile", () => {
      return profile();
    }),
    http.get("https://api.anthropic.com/api/oauth/usage", () => {
      return HttpResponse.json({});
    }),
  );
}

async function connectClaude(actor: Member) {
  signIn(actor);
  const created = await accept(
    providers.upsert({
      headers,
      body: {
        type: "claude-code-oauth-token",
        secret: `sk-ant-oat01-${randomUUID()}`,
      },
    }),
    [201],
  );
  return created.body.provider;
}

function deleteClaude(actor: Member) {
  signIn(actor);
  return providersByType.delete({
    headers,
    params: { type: "claude-code-oauth-token" },
  });
}

const notFound = Object.freeze({
  error: { code: "NOT_FOUND", message: "Resource not found" },
});

describe("DELETE /api/me/model-providers/:type", () => {
  it("me-model-providers-delete-003 deletes the member's personal Claude provider once", async () => {
    claudeProfile(() => {
      return HttpResponse.json({});
    });
    const owner = member();
    await connectClaude(owner);

    await accept(deleteClaude(owner), [204]);
    const repeated = await accept(deleteClaude(owner), [404]);
    expect(repeated.body).toMatchObject(notFound);
  });

  it("me-model-providers-delete-004 disconnects a Claude account added while its profile was unavailable", async () => {
    let profileAvailable = false;
    claudeProfile(() => {
      return profileAvailable
        ? HttpResponse.json({
            account: {
              uuid: randomUUID(),
              email: `claude_${randomUUID()}@example.test`,
            },
            organization: { uuid: randomUUID(), name: "Claude Workspace" },
          })
        : HttpResponse.json({ error: "unavailable" }, { status: 503 });
    });
    const owner = member();
    const provider = await connectClaude(owner);
    expect(provider).toMatchObject({ accountEmail: null, workspaceName: null });

    profileAvailable = true;
    await accept(deleteClaude(owner), [204]);
    signIn(owner);
    const listed = await accept(providers.list({ headers }), [200]);
    expect(listed.body.modelProviders).toStrictEqual([]);
    const repeated = await accept(deleteClaude(owner), [404]);
    expect(repeated.body).toMatchObject(notFound);
  });

  it("me-model-providers-delete-006 does not delete another member's provider in the same organization", async () => {
    claudeProfile(() => {
      return HttpResponse.json({});
    });
    const owner = member();
    const other = member(owner.orgId);
    await connectClaude(owner);

    const denied = await accept(deleteClaude(other), [404]);
    expect(denied.body).toMatchObject(notFound);
    await accept(deleteClaude(owner), [204]);
  });
});
