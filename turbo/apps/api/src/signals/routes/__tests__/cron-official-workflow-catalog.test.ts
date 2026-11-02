import {
  cronExecuteWorkflowAutomationsContract,
  cronOfficialWorkflowCatalogContract,
} from "@okouai/api-contracts/contracts/cron";
import { withMockNowForTest } from "../../../lib/time";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import { expect, test } from "vitest";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { proactiveSuggestionsRoutes } from "../proactive-preferences";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readClaimedContentBundle } from "./helpers/claimed-content-bundle";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cronOfficialWorkflowCatalogRoutes } from "../cron-official-workflow-catalog";

const context = testContext();

test("requires authentication to publish the Official Workflow catalog", async () => {
  mockEnv("CRON_SECRET", "official-workflow-catalog-cron-secret");
  const app = setupApp({
    context,
    routes: cronOfficialWorkflowCatalogRoutes,
  });
  const unauthorized = await accept(
    app(cronOfficialWorkflowCatalogContract).sync({}),
    [401],
  );
  expect(unauthorized.status).toBe(401);
});

test.each([false, true])(
  "publishes idempotently and delivers the Official bundle (upload failure: %s)",
  async (failUpload) => {
    mockEnv("CRON_SECRET", "official-workflow-catalog-cron-secret");
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronOfficialWorkflowCatalogRoutes,
        ...cronExecuteWorkflowAutomationsRoutes,
        ...proactiveSuggestionsRoutes,
        ...workflowAutomationsRoutes,
        ...workflowsRoutes,
      ],
    });
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    const s3 = installWorkflowVolumeS3Fixture(context);
    const cronHeaders = {
      authorization: "Bearer official-workflow-catalog-cron-secret",
    };
    if (failUpload) {
      context.mocks.s3.send.mockRejectedValueOnce(
        new Error("S3 publication unavailable"),
      );
      const rejected = await owned.run(() => {
        return accept(
          app(cronOfficialWorkflowCatalogContract).sync({
            headers: cronHeaders,
          }),
          [200],
        );
      });
      expect(rejected.body).toMatchObject({
        outcome: "rejected",
        releaseId: null,
        diagnostics: [{ code: "artifact-preparation-failed" }],
      });
    }
    const published = await owned.run(() => {
      return accept(
        app(cronOfficialWorkflowCatalogContract).sync({ headers: cronHeaders }),
        [200],
      );
    });
    expect(published.body).toMatchObject({
      outcome: "accepted",
      diagnostics: [],
    });
    const repeated = await owned.run(() => {
      return accept(
        app(cronOfficialWorkflowCatalogContract).sync({ headers: cronHeaders }),
        [200],
      );
    });
    expect(repeated.body).toStrictEqual({
      outcome: "unchanged",
      releaseId: published.body.releaseId,
      diagnostics: [],
    });
    const actor = owned.actor;
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization owner");
    }
    owned.ownsFeatureSwitches();
    await owned.run(() => {
      return updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.AgentSuggestion]: true },
      );
    });
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    const headers = { authorization: "Bearer clerk-session" };
    const enabled = await owned.run(() => {
      return accept(
        app(proactiveSuggestionsContract).update({
          headers,
          body: { enabled: true },
        }),
        [200],
      );
    });
    expect(enabled.body).toMatchObject({ enabled: true, status: "enabled" });
    const workflows = await owned.run(() => {
      return accept(
        app(workflowsCollectionContract).list({ headers, query: {} }),
        [200],
      );
    });
    const workflow = workflows.body.find((item) => {
      return item.official?.definitionName === "agent-suggestions";
    });
    if (!workflow) {
      throw new Error("Expected the Official Suggestions installation");
    }
    const automations = await owned.run(() => {
      return accept(
        app(workflowAutomationsContract).list({
          headers,
          params: { workflowId: workflow.id },
        }),
        [200],
      );
    });
    const automation = automations.body[0];
    if (!automation) {
      throw new Error("Expected the Suggestions automation");
    }
    if (!automation.nextRunAt) {
      throw new Error("Expected the next Suggestions schedule");
    }
    await withMockNowForTest(
      new Date(automation.nextRunAt).getTime(),
      async () => {
        await owned.run(() => {
          return accept(
            app(cronExecuteWorkflowAutomationsContract).execute({
              headers: cronHeaders,
            }),
            [200],
          );
        });
        await owned.run(flushWaitUntilForTest);
      },
    );
    const current = await owned.run(() => {
      return accept(
        app(workflowAutomationsContract).get({
          headers,
          params: { id: automation.id },
        }),
        [200],
      );
    });
    const chatThreadId = current.body.chatThreadId;
    if (!chatThreadId) {
      throw new Error("Expected the Suggestions execution thread");
    }
    const events = await owned.run(() => {
      return createChatFilesBddApi(context).listThreadEventRows(
        actor,
        chatThreadId,
      );
    });
    const launched = events.find((event) => {
      return event.eventType === "input.prompt" && event.runId;
    });
    if (!launched?.runId) {
      throw new Error("Expected the Official Workflow Run");
    }
    const runId = launched.runId;
    const { claim, sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      runId,
    );
    const bundle = claim.contentBundles.skills.find((skill) => {
      return skill.mountPath.endsWith("/agent-suggestions");
    });
    if (!bundle) {
      throw new Error("Expected an Official Workflow bundle in the claim");
    }
    const files = readClaimedContentBundle(s3.objects, bundle);
    expect(files.get("SKILL.md")?.toString()).toContain(
      "# Proactive Suggestions",
    );
    await owned.run(() => {
      return fixture.failChatRun(
        runId,
        sandboxHeaders,
        "Official Workflow inspected",
      );
    });
    await owned.run(flushWaitUntilForTest);
  },
);
