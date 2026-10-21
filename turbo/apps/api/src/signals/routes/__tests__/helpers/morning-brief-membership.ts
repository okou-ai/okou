import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  morningBriefPreferenceContract,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
  type OfficialWorkflowSourceDefinition,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { expect } from "vitest";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createCronOfficialWorkflowCatalogRoutes } from "../../cron-official-workflow-catalog";
import { morningBriefPreferenceRoutes } from "../../morning-brief-preference";
import { userPreferencesRoutes } from "../../user-preferences";
import { workflowAutomationsRoutes } from "../../workflow-automations";
import { workflowsRoutes } from "../../workflows";
import { createBddApi } from "./api-bdd";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import {
  activeDefinition,
  installCatalogStorageFixture,
} from "./official-workflow-catalog";
import { createRouteMocks } from "./route-test";

/** Keep one enabled-to-paused automation throughout the provider failure. */
export async function pauseBriefForMembershipFailure(context: TestContext) {
  const actor = createBddApi(context).user();
  const createdAt = new Date("2030-01-01T00:00:00.000Z");
  const mocks = createRouteMocks(context);
  const webhooks = createWebhookCallbackApi(context);
  const cronSecret = "official-workflow-installation-cron-secret";
  mockEnv("CRON_SECRET", cronSecret);
  installCatalogStorageFixture(context);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          id: `membership-${actor.userId}-${actor.orgId}`,
          role: actor.orgRole ?? "org:member",
          createdAt: createdAt.getTime(),
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ],
    },
  );
  function authHeaders() {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return { authorization: "Bearer clerk-session" };
  }
  async function publish(
    definitions: readonly OfficialWorkflowSourceDefinition[],
  ) {
    const app = await setupApp({
      context,
      routes: createCronOfficialWorkflowCatalogRoutes({
        schemaVersion: OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
        definitions,
      }),
      isolatePg: true,
    });
    const result = await accept(
      app(cronOfficialWorkflowCatalogContract).sync({
        headers: { authorization: `Bearer ${cronSecret}` },
      }),
      [200],
    );
    expect(result.body).toMatchObject({ outcome: "accepted", diagnostics: [] });
  }
  const enabledDefinitions = [
    activeDefinition(MORNING_BRIEF_OFFICIAL_DEFINITION_NAME, [
      {
        key: "daily-delivery",
        parameters: [],
        desiredState: {
          kind: "schedule",
          schedule: { type: "cron", cronExpression: "0 7 * * *" },
        },
      },
    ]),
  ];
  await publish(enabledDefinitions);
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.created",
    data: {
      id: actor.orgId,
      created_by: actor.userId,
      created_at: createdAt.getTime(),
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
  await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers: authHeaders(),
      body: { timezone: "Asia/Shanghai", locale: "en-US" },
    }),
    [200],
  );
  await accept(
    setupApp({ context, routes: morningBriefPreferenceRoutes })(
      morningBriefPreferenceContract,
    ).update({ headers: authHeaders(), body: { enabled: true } }),
    [200],
  );
  const installations = await accept(
    setupApp({
      context,
      routes: workflowsRoutes.filter(({ route }) => {
        return route === workflowsCollectionContract.list;
      }),
    })(workflowsCollectionContract).list({ headers: authHeaders(), query: {} }),
    [200],
  );
  const installation = installations.body.find((workflow) => {
    return (
      workflow.official?.definitionName ===
      MORNING_BRIEF_OFFICIAL_DEFINITION_NAME
    );
  });
  if (!installation) {
    throw new Error("Expected the existing Morning Brief installation");
  }
  const installationId = installation.id;
  async function readAutomations() {
    const result = await accept(
      setupApp({
        context,
        routes: workflowAutomationsRoutes.filter(({ route }) => {
          return route === workflowAutomationsContract.list;
        }),
      })(workflowAutomationsContract).list({
        headers: authHeaders(),
        params: { workflowId: installationId },
      }),
      [200],
    );
    return result.body;
  }
  const [before] = await readAutomations();
  if (!before) {
    throw new Error("Expected its existing automation");
  }
  expect(before).toMatchObject({
    enabled: true,
    official: { intendedEnabled: true, reconciliationStatus: "current" },
  });
  const publishUnconfiguredBrief = async () => {
    await publish([
      activeDefinition(MORNING_BRIEF_OFFICIAL_DEFINITION_NAME, [
        {
          key: "daily-delivery",
          parameters: [
            {
              key: "delivery-cron",
              type: "string",
              format: "text",
              required: true,
              default: "0 7 * * *",
            },
            {
              key: "delivery-timezone",
              type: "string",
              format: "timezone",
              required: true,
            },
          ],
          desiredState: {
            kind: "schedule",
            schedule: {
              type: "cron",
              cronExpression: { parameter: "delivery-cron" },
              timezone: { parameter: "delivery-timezone" },
            },
          },
        },
      ]),
    ]);
  };
  // Pause the same live automation through a genuine missing catalog binding.
  await publishUnconfiguredBrief();
  const paused = await accept(
    setupApp({ context, routes: morningBriefPreferenceRoutes })(
      morningBriefPreferenceContract,
    ).update({ headers: authHeaders(), body: { enabled: true } }),
    [409],
  );
  expect(paused.body.error.code).toBe("MORNING_BRIEF_STATE_CONFLICT");
  await flushWaitUntilForTest();
  await expect(readAutomations()).resolves.toMatchObject([
    {
      id: before.id,
      enabled: false,
      nextRunAt: null,
      official: {
        intendedEnabled: true,
        reconciliationStatus: "needs_reconfiguration",
      },
    },
  ]);
  // Recovery is otherwise possible before the provider starts rejecting reads.
  await publish(enabledDefinitions);
  return { actor, installationId, automationId: before.id, readAutomations };
}
