import type { ApiTestUser } from "./helpers/api-bdd";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createHmac, randomUUID } from "node:crypto";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRouteMocks } from "./helpers/route-test";
import { workflowAutomationsRoutes } from "../workflow-automations";

const context = testContext();
const api = createRunsApi(context);
const mocks = createRouteMocks(context);
const runs = createRunsApi(context);
const workflows = createWorkflowsBddApi(context);
const misc = createMiscRoutesApi(context);

const WORKFLOW_NAME = "official-result-email-fixture";

interface Scenario {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly runnerGroup: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function clerkUser(userId: string, email: string) {
  const emailId = `email_${userId}`;
  return {
    id: userId,
    emailAddresses: [{ id: emailId, emailAddress: email }],
    primaryEmailAddressId: emailId,
    firstName: "Official",
    lastName: "Automation",
    imageUrl: null,
  };
}

async function setupScenario(): Promise<Scenario> {
  const runnerGroup = runs.configureRunnerGroup();
  const { actor } = await workflows.setupWorkflowOrg();
  await runs.ensurePersonalSubscriptionModel(actor);
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  const { agentId } = await workflows.createAgent(actor, {
    displayName: "Official result email agent",
  });
  const workflowId = await workflows.createWorkflow(actor, {
    agentId,
    name: WORKFLOW_NAME,
  });
  mocks.clerk.session(actor.userId, actor.orgId, "org:member");
  mockClerkUsers(context, [clerkUser(actor.userId, actor.email)]);
  context.mocks.s3.send.mockResolvedValue({});
  const automation = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId },
      body: { schedule: { type: "loop", intervalSeconds: 3600 } },
    }),
    [201],
  );
  return {
    actor,
    agentId,
    workflowId,
    automationId: automation.body.id,
    runnerGroup,
  };
}

function unsubscribeToken(userId: string): string {
  const signature = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `${userId}.${signature}`;
}

beforeEach(() => {
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("RESEND_API_KEY", "official-result-email-resend-key");
  mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
  mockEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
  context.mocks.resend.send.mockReset();
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `resend-${randomUUID()}` },
    error: null,
  });
});

describe("Official Automation result email callbacks", () => {
  it("keeps the existing automation switch separate from account-level unsubscribe", async () => {
    const scenario = await setupScenario();

    await expect(
      misc.requestEmailUnsubscribe(
        unsubscribeToken(scenario.actor.userId),
        [200],
      ),
    ).resolves.toMatchObject({ body: { unsubscribed: true } });
    const afterUnsubscribe = await accept(
      automationsClient().get({
        headers: authHeaders(),
        params: { id: scenario.automationId },
      }),
      [200],
    );
    expect(afterUnsubscribe.body.enabled).toBeTruthy();

    const disabled = await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: scenario.automationId },
      }),
      [200],
    );
    expect(disabled.body.enabled).toBeFalsy();
    await expect(
      misc.requestEmailUnsubscribe(
        unsubscribeToken(scenario.actor.userId),
        [200],
      ),
    ).resolves.toMatchObject({ body: { unsubscribed: true } });
    const afterRepeatedUnsubscribe = await accept(
      automationsClient().get({
        headers: authHeaders(),
        params: { id: scenario.automationId },
      }),
      [200],
    );
    expect(afterRepeatedUnsubscribe.body.enabled).toBeFalsy();
  });
});
